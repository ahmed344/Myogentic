import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from .config import Settings
from .models import Assessment, LegacyAssessment

EXTENSIONS = {".ndpi", ".svs", ".tif", ".tiff", ".scn", ".mrxs", ".bif", ".vms", ".vmu", ".svslide"}


def slide_name(slide_id: str) -> str:
    # Reuse the full existing hash so annotations, drafts and bookmarks keep
    # their identities. Original names stay in the local database only.
    return f"SL-{slide_id.upper()}"


class Conflict(Exception):
    pass


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.scan_lock = Lock()
        settings.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS slides (
                    id TEXT PRIMARY KEY, source TEXT NOT NULL, relative_path TEXT NOT NULL,
                    name TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
                    available INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS revisions (
                    slide_id TEXT NOT NULL REFERENCES slides(id), reviewer TEXT NOT NULL,
                    kind TEXT NOT NULL, revision INTEGER NOT NULL,
                    saved_at TEXT NOT NULL, document TEXT NOT NULL, slide_fingerprint TEXT NOT NULL,
                    PRIMARY KEY(slide_id, reviewer, kind, revision)
                );
                PRAGMA user_version=1;
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.settings.database, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def scan(self):
        warnings = []
        found = []
        with self.scan_lock:
            for source in self.settings.sources:
                if not source.path.is_dir():
                    warnings.append(f"{source.label}: folder unavailable")
                    continue
                try:
                    for path in source.path.rglob("*"):
                        if path.suffix.lower() not in EXTENSIONS or not path.is_file():
                            continue
                        # Do not allow symlinks to expose files outside configured roots.
                        if not path.resolve().is_relative_to(source.path):
                            continue
                        relative = path.relative_to(source.path).as_posix()
                        identity = hashlib.sha256(f"{source.id}\0{relative}".encode()).hexdigest()[:24]
                        stat = path.stat()
                        found.append((identity, source.id, relative, path.name, stat.st_size, stat.st_mtime_ns))
                except OSError:
                    warnings.append(f"{source.label}: some files could not be indexed")
            with self.connect() as db:
                db.execute("UPDATE slides SET available=0")
                db.executemany("""INSERT INTO slides VALUES (?,?,?,?,?,?,1)
                    ON CONFLICT(id) DO UPDATE SET size=excluded.size,
                    modified_ns=excluded.modified_ns, available=1""", found)
        return {"indexed": len(found), "warnings": warnings}

    def slide(self, slide_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM slides WHERE id=?", (slide_id,)).fetchone()
        return dict(row) if row else None

    def path(self, slide_id):
        slide = self.slide(slide_id)
        if not slide or not slide["available"]:
            raise FileNotFoundError("Slide unavailable; reconnect its drive and rescan")
        source = next((s for s in self.settings.sources if s.id == slide["source"]), None)
        if source is None:
            raise FileNotFoundError("Slide source is no longer configured")
        path = (source.path / slide["relative_path"]).resolve()
        if not path.is_relative_to(source.path) or not path.is_file():
            raise FileNotFoundError("Slide unavailable in its configured folder")
        stat = path.stat()
        if (stat.st_size, stat.st_mtime_ns) != (slide["size"], slide["modified_ns"]):
            raise Conflict("Slide file changed since indexing. Rescan and check existing evidence before reviewing.")
        return path

    def assessment(self, slide_id, reviewer, kind):
        with self.connect() as db:
            row = db.execute("""SELECT * FROM revisions WHERE slide_id=? AND reviewer=? AND kind=?
                ORDER BY revision DESC LIMIT 1""", (slide_id, reviewer, kind)).fetchone()
        if row:
            return {"revision": row["revision"], "saved_at": row["saved_at"], "assessment": json.loads(row["document"])}
        return {"revision": 0, "saved_at": None, "assessment": Assessment().model_dump()}

    def save(self, slide_id, reviewer, kind, expected_revision, assessment: Assessment | LegacyAssessment):
        saved_at = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            latest = db.execute("""SELECT revision, json_extract(document, '$.schema_version') AS schema_version
                FROM revisions WHERE slide_id=? AND reviewer=? AND kind=? ORDER BY revision DESC LIMIT 1""",
                (slide_id, reviewer, kind)).fetchone()
            current = latest["revision"] if latest else 0
            if current != expected_revision:
                raise Conflict("A newer revision exists. Export your unsaved draft, then reload to review the saved version.")
            if latest and tuple(map(int, assessment.schema_version.split("."))) < tuple(map(int, latest["schema_version"].split("."))):
                raise Conflict("This review uses updated finding types. Export your draft and refresh the page before editing.")
            slide = db.execute("SELECT size,modified_ns,source,relative_path FROM slides WHERE id=?", (slide_id,)).fetchone()
            db.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?,?)", (
                slide_id, reviewer, kind, current + 1, saved_at, assessment.model_dump_json(), json.dumps(dict(slide))))
        return {"revision": current + 1, "saved_at": saved_at, "assessment": assessment.model_dump()}

    def list_slides(self, reviewer, kind):
        with self.connect() as db:
            rows = db.execute("""SELECT s.id, s.available, r.document, r.revision, r.saved_at FROM slides s
                LEFT JOIN revisions r ON r.slide_id=s.id AND r.reviewer=? AND r.kind=?
                AND r.revision=(SELECT MAX(r2.revision) FROM revisions r2 WHERE
                    r2.slide_id=s.id AND r2.reviewer=r.reviewer AND r2.kind=r.kind)""", (reviewer, kind)).fetchall()
        result = []
        for row in rows:
            slide = dict(row)
            doc = slide.pop("document")
            slide["name"] = slide_name(slide["id"])
            slide["status"] = json.loads(doc)["status"] if doc else "unassessed"
            result.append(slide)
        # A separate hash gives a repeatable shuffle, independent of filename,
        # source, reviewer and assessment status. Refreshing or adding slides
        # cannot reorder existing entries relative to each other.
        return sorted(result, key=lambda s: hashlib.sha256(f"review-order-v1\0{s['id']}".encode()).digest())

    def history(self, slide_id, reviewer, kind):
        with self.connect() as db:
            rows = db.execute("""SELECT revision, saved_at, document FROM revisions
                WHERE slide_id=? AND reviewer=? AND kind=? ORDER BY revision DESC""", (slide_id, reviewer, kind)).fetchall()
        return [{"revision": r["revision"], "saved_at": r["saved_at"], "assessment": json.loads(r["document"])} for r in rows]

    def export(self):
        with self.connect() as db:
            # One read transaction gives a consistent snapshot during autosaves/rescans.
            db.execute("BEGIN")
            slides = [dict(r) for r in db.execute("SELECT * FROM slides ORDER BY id")]
            revisions = [dict(r) for r in db.execute("SELECT * FROM revisions ORDER BY slide_id,reviewer,kind,revision")]
        for r in revisions:
            r["assessment"] = json.loads(r.pop("document"))
            r["slide_fingerprint"] = json.loads(r["slide_fingerprint"])
        return {"slides": slides, "revisions": revisions}

    def blinded_export(self):
        data = self.export()
        data["slides"] = [{"id": s["id"], "name": slide_name(s["id"]), "available": s["available"]}
                          for s in data["slides"]]
        for revision in data["revisions"]:
            # Preserve acquisition-file version hints without disclosing its
            # filename or source. SQLite backups retain the full provenance.
            revision["slide_fingerprint"] = {k: revision["slide_fingerprint"][k]
                                             for k in ("size", "modified_ns")}
        return data
