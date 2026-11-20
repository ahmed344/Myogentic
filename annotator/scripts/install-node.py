"""Install a checksum-verified official Node 24 runtime inside .tools (Linux/macOS)."""
import hashlib
import io
import platform
import tarfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1] / ".tools"
system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
arch = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
if not system or not arch:
    raise SystemExit("Install Node.js >=22.12 manually on this platform, then run setup.sh.")
version = (root.parent / ".node-version").read_text().strip()
base = f"https://nodejs.org/dist/v{version}/"
manifest = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60).read().decode()
digest, filename = next(line.split() for line in manifest.splitlines() if line.endswith(f"-{system}-{arch}.tar.gz"))
print(f"Downloading {filename}", flush=True)
archive = urllib.request.urlopen(base + filename, timeout=120).read()
if hashlib.sha256(archive).hexdigest() != digest:
    raise SystemExit("Node download checksum mismatch")
root.mkdir(exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
    bundle.extractall(root, filter="data")
link = root / "node"
if link.is_symlink():
    link.unlink()
link.symlink_to(filename.removesuffix(".tar.gz"), target_is_directory=True)
print(f"Node installed in {link}")
