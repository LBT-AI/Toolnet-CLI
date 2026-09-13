#!/usr/bin/env python3
"""
PTY acceptance for the ToolNet TUI.

Uses Python's stdlib `pty`/`os.openpty` (node-pty cannot compile here) to run
the built CLI inside a real pseudo-terminal at each target geometry, feed
keystrokes, resize mid-session, and assert on the raw byte stream:

  - alternate screen entered  (ESC[?1049h)
  - alternate screen left     (ESC[?1049l)  → clean teardown
  - cursor shown              (ESC[?25h)    → no raw-mode leak
  - composer prompt (">") painted
  - live resize (SIGWINCH) does not crash the TUI

Exit code 0 only when every geometry passes.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ENTRY = sys.argv[1] if len(sys.argv) > 1 else "dist/node/index.js"
SIZES = [(120, 40), (100, 30), (80, 24), (60, 20)]
READ_TIMEOUT = 0.3
SETTLE = 2.0


def drain(fd: int, duration: float, out: bytearray) -> None:
    deadline = time.time() + duration
    while time.time() < deadline:
        try:
            r, _, _ = select.select([fd], [], [], READ_TIMEOUT)
        except (OSError, ValueError):
            return
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        out.extend(chunk)


def resize_pty(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def run_session(cols: int, rows: int, resize: bool) -> tuple[bytearray, int]:
    master, slave = pty.openpty()
    resize_pty(master, cols, rows)

    env = dict(os.environ)
    env.update({"TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)})

    proc = subprocess.Popen(
        ["node", ENTRY],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=os.getcwd(),
        env=env,
        preexec_fn=os.setsid,
    )
    os.close(slave)

    output = bytearray()
    try:
        drain(master, SETTLE, output)

        # Esc — must be inert.
        os.write(master, b"\x1b")
        drain(master, 0.5, output)

        if resize:
            resize_pty(master, 60, 20)
            os.kill(proc.pid, signal.SIGWINCH)
            drain(master, 1.0, output)
            resize_pty(master, 120, 40)
            os.kill(proc.pid, signal.SIGWINCH)
            drain(master, 1.0, output)

        # Double Ctrl+C → exit.
        os.write(master, b"\x03")
        drain(master, 0.6, output)
        os.write(master, b"\x03")
        drain(master, 2.0, output)

        code = proc.poll()
        if code is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                code = -9
        drain(master, 0.3, output)
    finally:
        try:
            os.close(master)
        except OSError:
            pass

    return output, proc.returncode if proc.returncode is not None else -1


def main() -> int:
    failures = 0
    for cols, rows in SIZES:
        output, code = run_session(cols, rows, resize=False)
        ok = True
        notes = []
        if b"\x1b[?1049h" not in output:
            ok = False
            notes.append("alt-on")
        if b"\x1b[?1049l" not in output:
            ok = False
            notes.append("alt-off")
        if b"\x1b[?25h" not in output:
            ok = False
            notes.append("cursor-show")
        if b">" not in output:
            ok = False
            notes.append("prompt")
        status = "PASS" if ok else "FAIL(" + ",".join(notes) + ")"
        print(f"{status} {cols}x{rows} exit={code} bytes={len(output)}")
        failures += 0 if ok else 1

    # Live-resize acceptance at the default geometry.
    output, code = run_session(80, 24, resize=True)
    ok = b"\x1b[?1049h" in output and b"\x1b[?1049l" in output and b">" in output
    print(f"{'PASS' if ok else 'FAIL'} resize 80x24->60x20->120x40 exit={code} bytes={len(output)}")
    failures += 0 if ok else 1

    print(f"pty-acceptance: {'ALL PASS' if failures == 0 else str(failures) + ' FAILURES'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
