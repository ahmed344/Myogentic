"""Create a consistent, portable SQLite snapshot, including committed WAL data."""
import argparse
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.config import ROOT, load_settings


def backup_database(source: Path, destination: Path):
    if not source.is_file():
        raise SystemExit("No annotation database exists yet. Start the application first.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Reserve the output name exclusively, never overwrite an existing backup.
    with destination.open("xb"):
        pass
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
            with sqlite3.connect(destination) as snapshot:
                original.backup(snapshot)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = (args.destination or ROOT / f"data/backups/annotations-{stamp}.sqlite3").resolve()
    backup_database(load_settings().database.resolve(), destination)
    print(f"Backup saved: {destination}")
