"""Administrator-only local maintenance, sharing the controlled deployer's lock.

No SSH, registry access, container start/stop, or data-volume operations.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import shutil
import sys
import tarfile
import tempfile
import uuid

# Explicit sibling import works with Python -I; only use an administrator-reviewed directory.
_spec = importlib.util.spec_from_file_location("controlled_deploy", Path(__file__).with_name("deploy.py"))
deploy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deploy)


@contextlib.contextmanager
def maintenance_lock(state):
    deploy.retention_path(state, {0})
    with (state / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise deploy.DeployError("another deployment or maintenance operation is active") from error
        for name in ("active.json", "deployer-update-pending.json"):
            deploy.require(not (state / name).exists() and not (state / name).is_symlink(),
                           "pending recovery blocks maintenance")
        yield


def archive_image(path):
    """Validate a single-image Docker save archive without extracting any member."""
    manifest = None
    members = {}
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = member.name
            parts = PurePosixPath(name)
            deploy.require(not parts.is_absolute() and ".." not in parts.parts and "\\" not in name,
                           "unsafe archive path")
            deploy.require(member.isfile() or member.isdir(), "archive links/devices are not supported")
            deploy.require(name not in members and len(members) < 10000, "duplicate or excessive archive members")
            members[name] = member.isfile()
            if name == "manifest.json":
                deploy.require(member.size <= 1024 * 1024, "oversized Docker manifest")
                manifest = json.load(archive.extractfile(member))
    deploy.require(isinstance(manifest, list) and len(manifest) == 1, "expected single-image Docker save archive")
    entry = manifest[0]
    config_path = entry["Config"]
    deploy.require(members.get(config_path) and isinstance(entry["Layers"], list)
                   and entry["Layers"] and all(members.get(name) for name in entry["Layers"]),
                   "archive missing config or layers")
    config_bytes = None
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            if member.name == config_path:
                deploy.require(member.size <= 1024 * 1024, "oversized Docker config")
                config_bytes = archive.extractfile(member).read()
                break
    config = json.loads(config_bytes)
    deploy.require(config.get("os") == "linux" and config.get("architecture") == "amd64"
                   and (config.get("config", {}).get("Labels") or {}).get("org.opencontainers.image.source")
                   == deploy.SOURCE_LABEL, "archive is not this project's linux/amd64 image")
    return "sha256:" + hashlib.sha256(config_bytes).hexdigest()


def import_archive(source, expected_sha256, root, remove_source=False):
    """Publish a verified content-addressed object before unlinking an explicit legacy file."""
    owners = {0, pwd.getpwnam("admin").pw_uid}
    deploy.require(source.name == "investment-container.tar.gz", "only named deployment archives may be imported")
    source_info = deploy.retention_file(source, owners)
    deploy.require(root not in source.parents, "source is already inside managed artifacts")
    deploy.require(deploy.BACKUP_DIR.parent not in source.parents and deploy.VOLUME_ROOT not in source.parents,
                   "business backup and volume roots are never archive migration sources")
    deploy.require(len(expected_sha256) == 64 and all(c in "0123456789abcdef" for c in expected_sha256),
                   "invalid expected archive SHA-256")
    deploy.retention_path(root.parent, owners)
    root.mkdir(mode=0o700, exist_ok=True)
    deploy.retention_path(root, {0})
    deploy.require(shutil.disk_usage(root).free > source_info.st_size + 64 * 1024 * 1024,
                   "insufficient space for verified archive staging")
    staging = Path(tempfile.mkdtemp(prefix=".import-", dir=root))
    target = root / expected_sha256
    try:
        with source.open("rb") as reader, (staging / "archive.tar.gz").open("xb") as writer:
            opened = os.fstat(reader.fileno())
            deploy.require((opened.st_dev, opened.st_ino) == (source_info.st_dev, source_info.st_ino),
                           "source changed before copy")
            shutil.copyfileobj(reader, writer)
            writer.flush()
            os.fsync(writer.fileno())
        archive = staging / "archive.tar.gz"
        deploy.require(deploy.sha256_file(archive) == expected_sha256, "archive checksum mismatch")
        identifier = archive_image(archive)
        deploy.write_json(staging / "metadata.json", {
            "schema": 1, "sha256": expected_sha256, "image_id": identifier,
            "imported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        })
        if target.exists() or target.is_symlink():
            objects = {directory.name: metadata for directory, metadata, _ in deploy.managed_artifacts(root)}
            deploy.require(objects.get(expected_sha256, {}).get("image_id") == identifier
                           and deploy.sha256_file(target / "archive.tar.gz") == expected_sha256,
                           "existing artifact differs")
            # A deliberate re-import renews the pending-deployment grace period without another archive copy.
            deploy.write_json(target / "metadata.json", deploy.read_json(staging / "metadata.json"))
        else:
            os.rename(staging, target)
            fd = os.open(root, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        if remove_source:
            current = deploy.retention_file(source, owners)
            deploy.require((current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)
                           == (source_info.st_dev, source_info.st_ino, source_info.st_size, source_info.st_mtime_ns)
                           and deploy.sha256_file(source) == expected_sha256,
                           "source changed; kept both copies")
            source.unlink()  # No parent directory, sibling, checksum file, data or backup is deleted.
        return {"object": str(target), "image_id": identifier, "source_removed": remove_source}
    finally:
        if staging.exists():
            shutil.rmtree(staging)  # Only our private unpublished staging directory.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    imports = commands.add_parser("import-archive")
    imports.add_argument("source", type=Path)
    imports.add_argument("--sha256", required=True)
    imports.add_argument("--remove-source", action="store_true")
    commands.add_parser("retention")
    args = parser.parse_args()
    deploy.require(os.geteuid() == 0, "administrator root execution required")
    os.umask(0o077)
    with maintenance_lock(deploy.STATE_DIR):
        if args.command == "import-archive":
            result = import_archive(args.source, args.sha256, deploy.ARTIFACT_DIR, args.remove_source)
        else:
            driver = deploy.DockerDriver("", "")
            current = driver.container()
            driver.new_id = current["Image"]
            driver.verify(current["Config"]["Image"])
            root = deploy.STATE_DIR / "maintenance"
            root.mkdir(mode=0o700, exist_ok=True)
            deploy.retention_path(root, {0})
            record = root / uuid.uuid4().hex
            record.mkdir(mode=0o700)
            deploy.write_json(record / "cleanup.json", {"result": "running"})
            result = driver.cleanup(deploy.STATE_DIR, record)
            deploy.write_json(record / "cleanup.json", result)
            result = {"record": str(record), **result}
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (deploy.DeployError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print("Maintenance stopped (" + type(error).__name__ + "); no data-volume operations performed.", file=sys.stderr)
        sys.exit(1)
