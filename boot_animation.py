#!/usr/bin/env python3
"""
ToolNet CLI - Boot Animation & Interactive Prompt
Hiệu ứng: ASCII scan, neon corners, glitch text, gradient blocks
Requires: pip install rich
"""

import time
import random
import sys
from rich.console import Console, Group
from rich.text import Text
from rich.panel import Panel
from rich.align import Align
from rich.live import Live
from rich.style import Style

console = Console()

# === CONFIG ===
PINK = "#e879f9"
BLUE = "#3b82f6"
CYAN = "#67e8f9"
PURPLE = "#a855f7"
MAGENTA = "#d946ef"

# TOOLNET ASCII 8x7 blocks per letter, 7 letters = 49 cols + spacing
# Each letter: 7 cols wide, 8 rows tall
ASCII_TOOLNET = [
    "  TTTTT   OOOOO   OOOOO   L       N   N   EEEEE   TTTTT  ",
    "    T    O     O O     O  L       NN  N   E         T    ",
    "    T    O     O O     O  L       N N N   EEEE      T    ",
    "    T    O     O O     O  L       N  NN   E         T    ",
    "    T    O     O O     O  L       N  NN   E         T    ",
    "    T     OOOOO   OOOOO   LLLLL   N   N   EEEEE     T    ",
]

# Map each column to a color for gradient effect
COLORS = [PINK, PINK, PURPLE, BLUE, BLUE, CYAN, CYAN]

def color_for_col(col_idx: int, total: int) -> str:
    """Gradient across width: pink -> purple -> blue -> cyan"""
    ratio = col_idx / max(total - 1, 1)
    if ratio < 0.25:
        return PINK
    elif ratio < 0.5:
        return PURPLE
    elif ratio < 0.75:
        return BLUE
    else:
        return CYAN

def draw_corners():
    """Draw neon corner brackets"""
    corner_tl = Text.from_markup(f"[{MAGENTA}]┌{'─'*58}┐[/{MAGENTA}]")
    corner_bl = Text.from_markup(f"[{MAGENTA}]└{'─'*58}┘[/{MAGENTA}]")
    return corner_tl, corner_bl

def glitch_text(text: str, intensity: int = 3) -> Text:
    """Add glitch offset characters to text"""
    result = Text()
    for i, ch in enumerate(text):
        if ch == " ":
            result.append(" ")
            continue
        if random.random() < 0.15 and intensity > 0:
            offset_ch = random.choice(["█", "▓", "▒", "░", "▚", "▞"])
            result.append(offset_ch, style=Style(color=random.choice([BLUE, PURPLE]), blink=True))
            result.append(ch, style=Style(color=PINK, bold=True))
        else:
            result.append(ch, style=Style(color=PINK, bold=True))
    return result

def render_ascii_rows(progress: float) -> list[Text]:
    """Render ASCII art rows with pixel-reveal progress (0.0 -> 1.0)"""
    total_cols = len(ASCII_TOOLNET[0])
    reveal_col = int(total_cols * progress)
    rendered_rows = []

    for row in ASCII_TOOLNET:
        row_text = Text()
        for col_idx, ch in enumerate(row):
            if col_idx > reveal_col:
                row_text.append(" ")
            elif ch == " ":
                row_text.append(" ")
            else:
                if random.random() < 0.08:
                    block = random.choice(["█", "▓", "▒", "▚"])
                else:
                    block = "█"
                color = color_for_col(col_idx, total_cols)
                row_text.append(block, style=Style(color=color, bold=True))
        rendered_rows.append(row_text)
    return rendered_rows

def scanline() -> Text:
    """Horizontal scanline bar"""
    return Text.from_markup(f"[{MAGENTA}]{'─'*58}[/{MAGENTA}]")

def animate_boot():
    """Main boot animation sequence"""
    console.clear()

    corner_top, corner_bot = draw_corners()
    version = Text("CLI Version 1.0.0", style=Style(color=PURPLE, dim=True))

    with Live(console=console, refresh_per_second=30, screen=False) as live:
        # Phase 1: Build ASCII with scan
        for frame in range(0, 55):
            progress = frame / 54
            ascii_rows = render_ascii_rows(progress)
            welcome = glitch_text("Welcome to ToolNet")

            lines = []
            lines.append(corner_top)
            lines.append(Align.center(welcome, width=60))
            lines.append(Text(""))

            scan_idx = int(len(ascii_rows) * progress)
            for i, arow in enumerate(ascii_rows):
                if i == scan_idx:
                    lines.append(scanline())
                lines.append(Align.center(arow, width=60))

            lines.append(Text(""))
            lines.append(Align.center(version, width=60))
            lines.append(corner_bot)

            live.update(Group(*lines))
            time.sleep(0.04 + random.uniform(0, 0.02))

        # Phase 2: Hold with subtle glitch flicker
        for _ in range(20):
            ascii_rows = render_ascii_rows(1.0)
            lines = []
            lines.append(corner_top)
            lines.append(Align.center(glitch_text("Welcome to ToolNet", intensity=2), width=60))
            lines.append(Text(""))
            for arow in ascii_rows:
                lines.append(Align.center(arow, width=60))
            lines.append(Text(""))
            lines.append(Align.center(version, width=60))
            lines.append(corner_bot)
            live.update(Group(*lines))
            time.sleep(0.08)

    # Phase 3: Prompt
    show_prompt()

def show_prompt():
    """Show the trust prompt like GitHub Copilot CLI"""
    console.print()

    path_text = Text("/root", style=Style(color="#9ca3af"))
    path_panel = Panel(path_text, border_style="#333333", padding=(0, 2), width=12)
    console.print(path_panel)
    console.print()

    desc = (
        "ToolNet can read files in this folder and, with your permission,\n"
        "edit them or run code and shell commands. It will remember\n"
        "your permissions for the rest of this session.\n\n"
        "Do you trust the files in this folder?"
    )
    console.print(desc, style="white")
    console.print()

    options = [
        ("1. Yes", True),
        ("2. Yes, and remember this folder for future sessions", False),
        ("3. No (Esc)", False),
    ]

    for opt, active in options:
        if active:
            console.print(f"[black on #0ea5e9]> {opt}[/black on #0ea5e9]")
        else:
            console.print(f"  {opt}")

    console.print()
    console.print("↑/↓ to navigate · enter to select · esc to cancel", style="dim")
    console.print()

    with console.status("[bold cyan]Waiting for input...", spinner="dots"):
        time.sleep(1)
    console.print("[bold green]✓ Trusted. ToolNet is ready.[/bold green]")

if __name__ == "__main__":
    try:
        animate_boot()
    except KeyboardInterrupt:
        console.print("\n[red]Aborted.[/red]")
        sys.exit(1)
