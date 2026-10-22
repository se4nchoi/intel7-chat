"""Filename policy for cohort files, including nonstandard classroom formats."""
from pathlib import Path
from unicodedata import category

BLOCKED_SUFFIXES = frozenset({
    ".app", ".bat", ".cmd", ".com", ".cpl", ".dll", ".dmg", ".exe",
    ".hta", ".htm", ".html", ".jar", ".js", ".jse", ".lnk",
    ".mjs", ".msi", ".msp", ".pif", ".ps1", ".reg", ".scr",
    ".svg", ".vbe", ".vbs", ".wsf", ".wsh",
})


def safe_filename(value: str | None) -> str:
    name = (value or "").replace("\\", "/").split("/")[-1]
    name = "".join(char for char in name if ord(char) >= 32 and category(char) not in {"Cf", "Cs"} and char not in '<>:"|?*').strip(" .")
    if not name:
        raise ValueError("File name is required")
    if len(name) > 180:
        suffix = Path(name).suffix[:20]
        name = name[:180 - len(suffix)] + suffix
    if Path(name).suffix.casefold() in BLOCKED_SUFFIXES:
        raise ValueError("Executable or active web files cannot be shared")
    return name
