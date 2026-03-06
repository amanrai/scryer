"""
Filesystem helpers for Scryer planning folder hierarchy.

Each project/sub-project/ticket gets a folder under scryer_root:
  {scryer_root}/
    ProjectName/
      .planning/
      SubProject/
        .planning/
        T5-ticket-slug/
          .planning/

All public functions are safe to call when scryer_root is unset — they return
None/no-op gracefully. All callers in db.py wrap these in try/except so a
filesystem error never interrupts a DB operation.
"""

import re
import subprocess
from pathlib import Path
import os
import sqlite3

_DB_PATH = Path(os.environ.get("PM_DB_PATH", Path(__file__).parent / "data" / "pm.db"))


def get_scryer_root() -> str | None:
    """Read scryer_root from scryer_config table. Returns None if unset or table absent."""
    try:
        conn = sqlite3.connect(str(_DB_PATH))
        row = conn.execute(
            "SELECT value FROM scryer_config WHERE key = 'scryer_root'"
        ).fetchone()
        conn.close()
        if row and row[0]:
            return str(Path(row[0]).expanduser().resolve())
        return None
    except Exception:
        return None


def slugify(title: str) -> str:
    """Lowercase, non-alphanumeric runs → hyphens, max 40 chars."""
    s = title.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = s.strip('-')
    return s[:40].rstrip('-')


def ticket_folder_name(ticket_id: int, title: str) -> str:
    return f"T{ticket_id}-{slugify(title)}"


def location_to_path(root: str, location: str) -> Path:
    """
    Convert a breadcrumb location string (e.g. "Scryer > UI") to a Path
    under root (e.g. /scryer_root/Scryer/UI).
    """
    parts = [p.strip() for p in location.split(">")]
    return Path(root).joinpath(*parts)


def ensure_planning_folder(path: Path) -> None:
    """Create path and path/.planning/ (mkdir -p)."""
    (path / ".planning").mkdir(parents=True, exist_ok=True)


def ensure_git_repo(root: Path) -> None:
    """Run git init in root if .git doesn't exist yet."""
    if not (root / ".git").exists():
        subprocess.run(
            ["git", "init", str(root)],
            capture_output=True,
            check=False,
        )


def find_ticket_folder(root: Path, ticket_id: int) -> Path | None:
    """Glob for T{id}-*/ anywhere under root. Returns first match or None."""
    prefix = f"T{ticket_id}-"
    for match in root.rglob(f"T{ticket_id}-*"):
        if match.is_dir() and match.name.startswith(prefix):
            return match
    return None
