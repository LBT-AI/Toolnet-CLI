#!/usr/bin/env python3
"""
PTY visual verification for the ToolNet CLI main TUI.

Goal: prove that in EVERY state there is exactly ONE provider/model bar,
ONE input line, and ONE workspace/status bar (no duplicate main TUI).

Runs the real `toolnet` binary inside a PTY at 50x20, 60x25, 80x30 and replays
the byte stream through a minimal VT emulator, then asserts the visible screen
contains exactly one of each core component.

Usage: python3 tools/pty_verify.py [--interactive]
"""
import os
import pty
import re
import select
import signal
import struct
import fcntl
import sys
import termios
import time
import argparse

TIOCSCTTY = 0x540E

TIOCSWINSZ = 0x5414


class VTEmulator:
    """Minimal VT100/ANSI emulator: home, absolute goto, clear screen/line,
    erase-down, CR/LF, SGR (ignored), UTF-8 printing, alt-screen reset."""

    def __init__(self, rows: int, cols: int):
        self.rows = rows
        self.cols = cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.cursor_row = 0
        self.cursor_col = 0
        self.pending_wrap = False

    def clear_screen(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.cursor_row = 0
        self.cursor_col = 0
        self.pending_wrap = False

    def _write_char(self, ch: str):
        # Real-terminal wrap semantics: writing the LAST column keeps the cursor
        # there with a pending wrap; the next printable character moves to the
        # next line first (scrolling at the bottom). Control sequences cancel it.
        if self.pending_wrap:
            self.pending_wrap = False
            if self.cursor_row < self.rows - 1:
                self.cursor_row += 1
            else:
                self.grid = self.grid[1:] + [[" "] * self.cols]
                self.cursor_row = self.rows - 1
            self.cursor_col = 0
        if self.cursor_row < self.rows and self.cursor_col < self.cols:
            self.grid[self.cursor_row][self.cursor_col] = ch
        self.cursor_col += 1
        if self.cursor_col >= self.cols:
            self.cursor_col = self.cols - 1
            self.pending_wrap = True

    def _cancel_wrap(self):
        self.pending_wrap = False

    def _scroll_up(self):
        self.grid = self.grid[1:] + [[" "] * self.cols]

    def process(self, data: bytes):
        i = 0
        n = len(data)
        while i < n:
            b = data[i]
            if b == 0x1B:  # ESC -> CSI / OSC / misc
                if i + 1 < n and data[i + 1] == 0x5B:  # CSI '[' or '[?'
                    i += 2
                    params = []
                    private = False
                    if i < n and data[i] == 0x3F:
                        private = True
                        i += 1
                    while i < n and (0x30 <= data[i] <= 0x3F):
                        cur = b""
                        while i < n and data[i] not in (0x3B,) and not (0x40 <= data[i] <= 0x7E):
                            cur += bytes([data[i]]); i += 1
                        params.append(cur)
                        if i < n and data[i] == 0x3B:
                            i += 1
                    final = data[i] if i < n else 0x40
                    i += 1
                    self._csi(params, final, private)
                elif i + 1 < n and data[i + 1] == 0x5D:  # OSC ']'
                    i += 2
                    while i < n:
                        if data[i] == 0x07:
                            i += 1; break
                        if data[i] == 0x1B and i + 1 < n and data[i + 1] == 0x5C:
                            i += 2; break
                        i += 1
                else:
                    i += 2
            elif b == 0x0A:  # LF
                self._cancel_wrap()
                if self.cursor_row < self.rows - 1:
                    self.cursor_row += 1
                else:
                    self._scroll_up()
                i += 1
            elif b == 0x0D:  # CR
                self._cancel_wrap()
                self.cursor_col = 0
                i += 1
            elif b in (0x07, 0x08, 0x00):
                i += 1
            elif 0x20 <= b < 0x7F:
                self._write_char(chr(b))
                i += 1
            elif 0xC2 <= b <= 0xDF:
                if i + 1 < n:
                    self._write_char(chr(((b & 0x1F) << 6) | (data[i + 1] & 0x3F)))
                    i += 2
                else:
                    i += 1
            elif 0xE0 <= b <= 0xEF:
                if i + 2 < n:
                    self._write_char(chr(((b & 0x0F) << 12) | ((data[i + 1] & 0x3F) << 6) | (data[i + 2] & 0x3F)))
                    i += 3
                else:
                    i += 1
            elif b >= 0xF0:
                self._write_char("\uFFFD")
                i += 4
            else:
                i += 1

    def _csi(self, params, final: int, private: bool):
        if private:
            if final == 0x68 and params and params[0] == b"1049":  # ?1049h (alt on)
                self.clear_screen()
            elif final == 0x68 and params and params[0] == b"25":
                pass  # cursor show
            elif final == 0x6C and params and params[0] == b"25":
                pass  # cursor hide
            return
        if final == 0x48:  # H - cursor position
            self._cancel_wrap()
            r = int("".join(params[0].decode(errors="ignore")) or "1") if params and params[0] else 1
            c = int("".join(params[1].decode(errors="ignore")) or "1") if len(params) > 1 and params[1] else 1
            self.cursor_row = max(0, min(self.rows - 1, r - 1))
            self.cursor_col = max(0, min(self.cols - 1, c - 1))
        elif final == 0x4A:  # J - erase display
            self._cancel_wrap()
            param = 0
            if params and params[0]:
                try:
                    param = int("".join(params[0].decode(errors="ignore")))
                except ValueError:
                    param = 0
            if param == 0:  # cursor -> end
                for c in range(self.cursor_col, self.cols):
                    self.grid[self.cursor_row][c] = " "
                for r in range(self.cursor_row + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
            elif param in (2, 3):
                self.clear_screen()
        elif final == 0x4B:  # K - erase in line
            self._cancel_wrap()
            param = 0
            if params and params[0]:
                try:
                    param = int("".join(params[0].decode(errors="ignore")))
                except ValueError:
                    param = 0
            if param == 0:
                for c in range(self.cursor_col, self.cols):
                    self.grid[self.cursor_row][c] = " "
            elif param == 2:
                self.grid[self.cursor_row] = [" "] * self.cols
            elif param == 1:
                for c in range(0, self.cursor_col + 1):
                    self.grid[self.cursor_row][c] = " "
        # 'm' (SGR) and everything else: ignored

    def get_screen(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid)


def set_terminal_size(fd: int, rows: int, cols: int):
    fcntl.ioctl(fd, TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_all(master, emu, seconds: float):
    deadline = time.time() + seconds
    while time.time() < deadline:
        rr, _, _ = select.select([master], [], [], 0.05)
        if rr:
            try:
                data = os.read(master, 8192)
            except OSError:
                break
            if not data:
                break
            emu.process(data)


def drain_to_string(master, seconds: float) -> bytes:
    """Collect raw bytes for `seconds`, returning them so the caller can replay
    them into a FRESH emulator (isolating the final frame from accumulated
    stale rows of earlier frames)."""
    buf = b""
    deadline = time.time() + seconds
    while time.time() < deadline:
        rr, _, _ = select.select([master], [], [], 0.05)
        if rr:
            try:
                data = os.read(master, 8192)
            except OSError:
                break
            if not data:
                break
            buf += data
    return buf


def spawn(cols: int, rows: int, cwd: str):
    master, slave = pty.openpty()
    set_terminal_size(slave, rows, cols)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        # Acquire the pty slave as the controlling terminal so kernel
        # SIGWINCH (from set_terminal_size on the master) reaches the app.
        try:
            fcntl.ioctl(slave, TIOCSCTTY, 0)
        except OSError:
            pass
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.chdir(cwd)
        os.execvp("bun", ["bun", "src/index.tsx", "--no-color", "--no-splash", "--no-banner"])
        os._exit(127)
    os.close(slave)
    return master, pid


def kill_child(pid: int):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass


FOOTER_TAG = " · "  # compact footer: "Alibaba Cloud · qwen-plus · /root/toolnet-cli"
FRAME_MARK = b"\x1b[?25l\x1b[H"              # every frame begins with hide-cursor + home


def last_complete_frame(raw: bytes) -> bytes:
    """Cut `raw` to the newest COMPLETE frame: bytes from the second-to-last
    hide+home up to the last hide+home. A frame is complete only once the next
    frame's start-mark has arrived; the trailing run-on after the last mark is
    a partially-written frame and is dropped.

    The ALT-SCREEN is a total-replace display: each frame paints the FULL
    screen (home + redraw + clear-down). The visible result of a sequence of
    frames IS the final frame — earlier ones are overwritten row by row. So
    inspecting the newest complete frame is exactly what the user sees."""
    marks = []
    start = 0
    while True:
        idx = raw.find(FRAME_MARK, start)
        if idx == -1:
            break
        marks.append(idx)
        start = idx + len(FRAME_MARK)
    if not marks:
        return raw
    if len(marks) >= 2:
        return raw[marks[-2] + len(FRAME_MARK):marks[-1]]
    return raw[marks[0] + len(FRAME_MARK):]


def snap(master, seconds: float, cols: int, rows: int):
    """Collect bytes, cut to the newest COMPLETE frame, and render it in a
    fresh emulator — i.e. the single, latest screen exactly as the user sees it.

    The app runs under `bun src/index.tsx`, whose first cold-start compile can
    lag the initial frame. If the window elapses without a single frame mark,
    keep collecting for one extra window so a slow first paint is never mistaken
    for an empty/partial screen."""
    raw = drain_to_string(master, seconds)
    if FRAME_MARK not in raw:
        raw += drain_to_string(master, seconds)
    emu = VTEmulator(rows, cols)
    emu.process(last_complete_frame(raw))
    return emu


def inspect_frame(emu):
    lines = [l.rstrip() for l in emu.get_screen().split("\n")]
    # New minimal design:
    #   - footer = compact "provider · model · workspace" (the LAST grid row,
    #     it contains " · " and never starts with a modal wall or ">")
    #   - input  = "> …" prompt line (with placeholder or typed text)
    #   - status = optional working-status line: spinner/●/✔/✖/⚠ or "Shortcuts:"
    footer_hits = [
        l for l in lines
        if FOOTER_TAG in l
        and not l.startswith(("│", "╰", "╭", ">", "…", "❯"))
        and not l.startswith(("Allow", "Deny"))
    ]
    input_hits = [l for l in lines if l.startswith("> ") or "Enter a coding task" in l]
    status_hits = [l for l in lines if re.match(r"^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●✔✖✓✗⚠▲]", l) or l.startswith("Shortcuts:")]
    return footer_hits, input_hits, status_hits, lines


def check_frame(emu, tag, cols, rows):
    """Assert the single frame has exactly ONE provider/model bar (footer),
    exactly ONE input line, and at most ONE status line — no duplicates."""
    footer_hits, input_hits, status_hits, _ = inspect_frame(emu)
    errors = []
    if len(footer_hits) != 1:
        errors.append(f"provider/model+workspace bar = {len(footer_hits)} (want exactly 1):")
        for l in footer_hits:
            errors.append("    |" + l + "|")
    if len(input_hits) != 1:
        errors.append(f"input line = {len(input_hits)} (want exactly 1):")
        for l in input_hits:
            errors.append("    |" + l + "|")
    if len(status_hits) > 1:
        errors.append(f"status line = {len(status_hits)} (want at most 1):")
        for l in status_hits:
            errors.append("    |" + l + "|")
    print(f"[{cols}x{rows} {tag}] footer={len(footer_hits)} input={len(input_hits)} status={len(status_hits)}")
    for e in errors:
        print("   ERROR:", e)
    return not errors


def verify(cols: int, rows: int, cwd: str, interactive: bool = False):
    master, pid = spawn(cols, rows, cwd)
    emu = VTEmulator(rows, cols)
    ok = True
    try:
        # 1. Startup — the newest single frame (workspace-trust modal may be on
        #    top, but the base frame + footer + input are always composed once).
        emu = snap(master, 4.0, cols, rows)
        ok &= check_frame(emu, "startup", cols, rows)
        if interactive:
            print(f"\n=== {cols}x{rows} startup frame ===")
            print(emu.get_screen())

        screen = emu.get_screen()
        new_cols, new_rows = cols, rows
        if "Allow for this session" in screen or "Security approval" in screen:
            # 1B. Resize while the approval modal is OPEN — base frame must stay
            # single and the modal must stay centered on the new size.
            new_cols, new_rows = max(30, cols - 4), max(15, rows - 3)
            set_terminal_size(master, new_rows, new_cols)
            emu = snap(master, 1.5, new_cols, new_rows)
            ok &= check_frame(emu, "approval-resized", new_cols, new_rows)
            modal_screen = emu.get_screen()
            if "Allow" not in modal_screen:
                ok = False
                print(f"   ERROR: approval modal lost during resize ({new_cols}x{new_rows})")
            if interactive:
                print(f"\n=== {cols}x{rows} approval modal resized to {new_cols}x{new_rows} ===")
                print(emu.get_screen())

            # 1C. Close via 'a' (allow for session) and continue startup. The
            # per-option/deny/Esc/re-open behavior is covered by the unit
            # regression suite; here we only need the single-frame invariant
            # while the overlay is active and after it closes.
            os.write(master, b"a")
            emu = snap(master, 1.5, new_cols, new_rows)
            ok &= check_frame(emu, "trust-approved", new_cols, new_rows)
            if interactive:
                print(f"\n=== {cols}x{rows} after trust approval ===")
                print(emu.get_screen())

        # Verify the API-key modal state if it shows up, then submit a key so we
        # can reach the true idle TUI.
        screen = emu.get_screen()
        if "Connect provider" in screen or "Paste key" in screen:
            ok &= check_frame(emu, "apikey-modal", new_cols, new_rows)
            os.write(master, b"sk-test-key-123456789\r")
            emu = snap(master, 3.0, new_cols, new_rows)
            ok &= check_frame(emu, "key-saved", new_cols, new_rows)
            if interactive:
                print(f"\n=== {cols}x{rows} after key entry ===")
                print(emu.get_screen())

        ok &= check_frame(emu, "idle", new_cols, new_rows)

        # 2. /tools overlay opens on top of the very same single frame.
        os.write(master, b"/tools\r")
        emu = snap(master, 1.5, new_cols, new_rows)
        ok &= check_frame(emu, "tools-overlay-open", new_cols, new_rows)
        if interactive:
            print(f"\n=== {new_cols}x{new_rows} /tools overlay ===")
            print(emu.get_screen())

        # 3. Esc closes the overlay — base frame only, still exactly once each.
        os.write(master, b"\x1b")
        emu = snap(master, 1.0, new_cols, new_rows)
        ok &= check_frame(emu, "tools-overlay-closed", new_cols, new_rows)

        # 4. Resize (mobile path): SIGWINCH-triggered single re-render. The
        # size must actually CHANGE — the kernel only sends SIGWINCH when the
        # winsize differs, so re-setting the same size yields no repaint.
        grow_cols, grow_rows = min(90, new_cols + 8), min(40, new_rows + 5)
        set_terminal_size(master, grow_rows, grow_cols)
        emu = snap(master, 1.5, grow_cols, grow_rows)
        ok &= check_frame(emu, "resized", grow_cols, grow_rows)
        new_cols, new_rows = grow_cols, grow_rows
        if interactive:
            print(f"\n=== {grow_cols}x{grow_rows} resized ===")
            print(emu.get_screen())

        # 5. Typing a prompt, then clearing it, must not duplicate anything.
        os.write(master, b"hello world task")
        emu = snap(master, 0.6, new_cols, new_rows)
        ok &= check_frame(emu, "typing", new_cols, new_rows)
        os.write(master, b"\x15")  # Ctrl-U clears the input line
        emu = snap(master, 1.0, new_cols, new_rows)
        ok &= check_frame(emu, "cleared", new_cols, new_rows)

        if interactive:
            print(f"\n=== {new_cols}x{new_rows} final cleared frame ===")
            print(emu.get_screen())

        return ok
    finally:
        kill_child(pid)
        os.close(master)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--interactive", action="store_true", help="print raw screen snapshots")
    args = parser.parse_args()

    cwd = sys.argv[1] if len(sys.argv) > 2 and not sys.argv[1].startswith("--") else os.getcwd()
    sizes = [(50, 20), (60, 25), (80, 30), (120, 40)]
    results = []
    for cols, rows in sizes:
        try:
            ok = verify(cols, rows, cwd, args.interactive)
            results.append((cols, rows, ok))
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            results.append((cols, rows, False))

    print("\n================================")
    passed = sum(1 for _, _, ok in results if ok)
    print(f"PTY DUPLICATE-CHECK: {passed}/{len(results)} passed")
    for cols, rows, ok in results:
        print(f"  {cols}x{rows}: {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()