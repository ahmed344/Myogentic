import sqlite3

import pytest

from scripts.backup import backup_database


def test_backup_includes_wal_and_never_overwrites(tmp_path):
    source, destination = tmp_path / "source.sqlite3", tmp_path / "backup.sqlite3"
    with sqlite3.connect(source) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE notes (text TEXT)")
        db.execute("INSERT INTO notes VALUES ('retained annotation')")
        db.commit()
        backup_database(source, destination)
        with sqlite3.connect(destination) as copied:
            assert copied.execute("SELECT text FROM notes").fetchone()[0] == "retained annotation"
        with pytest.raises(FileExistsError):
            backup_database(source, destination)
