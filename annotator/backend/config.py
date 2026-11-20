import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    path: Path


@dataclass(frozen=True)
class Settings:
    database: Path
    sources: tuple[Source, ...]


def load_settings() -> Settings:
    path = Path(os.environ.get("MYOGENTIC_CONFIG", ROOT / "config.toml"))
    if not path.exists():
        path = ROOT / "config.example.toml"
    config = tomllib.loads(path.read_text())
    database = Path(config.get("database", "data/annotations.sqlite3")).expanduser()
    sources = tuple(Source(s["id"], s["label"], Path(s["path"]).expanduser().resolve()) for s in config["sources"])
    if len({s.id for s in sources}) != len(sources):
        raise ValueError("Every source must have a unique, stable ID")
    return Settings(database if database.is_absolute() else ROOT / database, sources)
