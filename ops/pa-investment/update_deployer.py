"""Fixed root updater: independently verify public source, then replace only deploy.py.

The caller can select a reviewed mainline revision, never supply code or a destination.
This file and its sudo entry are installed by an administrator, not self-updated.
"""

import base64
import binascii
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import uuid


REPOSITORY = "PABIPRG/pa-investment-research"
SOURCE_PATH = "ops/pa-investment/deploy.py"
TARGET = Path("/usr/local/libexec/pa-investment/deploy.py")
STATE = Path("/var/lib/pa-investment-deploy")
MAX_SOURCE_BYTES = 256 * 1024
MAX_API_BYTES = 1024 * 1024
REVISION = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")


class UpdateError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise UpdateError(message)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def validate_request(revision, digest):
    require(isinstance(revision, str) and REVISION.fullmatch(revision), "invalid source revision")
    require(isinstance(digest, str) and DIGEST.fullmatch(digest), "invalid source SHA-256")


def read_request(stream):
    value = stream.read(513)
    lines = value.splitlines()
    require(len(value) <= 512 and value.endswith("\n") and len(lines) == 2, "invalid update request")
    validate_request(*lines)
    return tuple(lines)


def checked_path(path, kind=None):
    require(path.is_absolute(), "path must be absolute")
    for entry in [*reversed(path.parents), path]:
        info = entry.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "untrusted deployment path: " + str(entry))
        if entry != path or kind == "directory":
            require(stat.S_ISDIR(info.st_mode), "expected directory: " + str(entry))
        elif kind == "file":
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "expected regular file: " + str(entry))
    return info


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, payload, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix=".deployer-update-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def write_json(path, value):
    atomic_write(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def read_bytes(path, limit):
    checked_path(path, kind="file")
    with path.open("rb") as source:
        value = source.read(limit + 1)
    require(len(value) <= limit, "deployment file exceeds size limit")
    return value


def read_json(path):
    try:
        return json.loads(read_bytes(path, 16 * 1024))
    except (ValueError, UnicodeError) as error:
        raise UpdateError("invalid deployment metadata") from error


def validate_release(value):
    require(isinstance(value, dict) and set(value) == {"schema", "revision", "sha256"}
            and value["schema"] == 1, "invalid deployment release metadata")
    validate_request(value["revision"], value["sha256"])
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UpdateError("GitHub source redirects are not allowed")


class GitHubSource:
    def api(self, path):
        request = urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + "/" + path,
                                         headers={"Accept": "application/vnd.github+json",
                                                  "X-GitHub-Api-Version": "2022-11-28",
                                                  "User-Agent": "pa-investment-deployer-updater"})
        # Ignore proxy environment variables and reject redirects to alternate source hosts.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=20) as response:
                require(response.status == 200, "GitHub source request failed")
                payload = response.read(MAX_API_BYTES + 1)
            require(len(payload) <= MAX_API_BYTES, "GitHub response exceeds size limit")
            value = json.loads(payload)
            require(isinstance(value, dict), "invalid GitHub source response")
            return value
        except (urllib.error.URLError, ValueError, UnicodeError, TimeoutError) as error:
            raise UpdateError("cannot verify source with GitHub; retry after connectivity or rate-limit recovery") from error

    def require_ancestor(self, base, head):
        require(REVISION.fullmatch(base) and (head == "master" or REVISION.fullmatch(head)),
                "invalid ancestry request")
        # Files are included only on page 1. Avoid unbounded patch payloads for old releases.
        comparison = self.api("compare/" + base + "..." + head + "?per_page=1&page=2")
        require(comparison.get("status") in {"ahead", "identical"},
                "source is outside approved master history or would downgrade the installed deployer")
        require(comparison.get("base_commit", {}).get("sha") == base
                and comparison.get("merge_base_commit", {}).get("sha") == base,
                "source ancestry identity does not match")

    def read(self, revision):
        require(REVISION.fullmatch(revision), "invalid source revision")
        file = self.api("contents/" + SOURCE_PATH + "?ref=" + revision)
        require(file.get("type") == "file" and file.get("path") == SOURCE_PATH
                and file.get("encoding") == "base64", "unexpected source file")
        require(isinstance(file.get("size"), int) and 0 < file["size"] <= MAX_SOURCE_BYTES,
                "invalid source size")
        try:
            source = base64.b64decode("".join(file["content"].splitlines()), validate=True)
        except (KeyError, AttributeError, ValueError, binascii.Error) as error:
            raise UpdateError("invalid source encoding") from error
        require(len(source) == file["size"], "source size does not match")
        blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
        require(blob == file.get("sha"), "source Git blob does not match")
        return source


class Updater:
    def __init__(self, target=TARGET, state=STATE, source=None):
        self.target, self.state = target, state
        self.source = source or GitHubSource()
        self.release = state / "deployer-release.json"
        self.pending = state / "deployer-update-pending.json"
        self.records = state / "deployer-updates"

    def installed_release(self):
        return validate_release(read_json(self.release)) if self.release.exists() else None

    def recover_pending(self):
        if not self.pending.exists():
            return
        journal = read_json(self.pending)
        require(isinstance(journal, dict) and set(journal) == {"record", "previous", "target", "old_sha256"},
                "invalid pending update")
        require(isinstance(journal["record"], str) and re.fullmatch(r"[0-9a-f]{32}", journal["record"]),
                "invalid update record")
        target = validate_release(journal["target"])
        previous = journal["previous"]
        if previous is not None:
            validate_release(previous)
            require(previous["sha256"] == journal["old_sha256"], "invalid previous update identity")
        require(isinstance(journal["old_sha256"], str) and DIGEST.fullmatch(journal["old_sha256"]),
                "invalid backup identity")
        record = self.records / journal["record"]
        checked_path(record, kind="directory")
        backup = read_bytes(record / "deploy.py.before", MAX_SOURCE_BYTES)
        require(sha256(backup) == journal["old_sha256"], "update backup does not match")
        actual = sha256(read_bytes(self.target, MAX_SOURCE_BYTES))
        require(actual in {journal["old_sha256"], target["sha256"]},
                "installed script changed during recovery; administrator inspection required")
        require(self.installed_release() in (previous, target), "installed release changed during recovery")
        if actual != journal["old_sha256"]:
            atomic_write(self.target, backup, 0o644)
        if previous is None:
            if self.release.exists():
                self.release.unlink()
                sync_directory(self.state)
        else:
            write_json(self.release, previous)
        write_json(record / "result.json", {"result": "rolled-back", "previous": previous, "target": target})
        self.pending.unlink()
        sync_directory(self.state)

    @contextlib.contextmanager
    def locked(self):
        checked_path(self.state, kind="directory")
        checked_path(self.target, kind="file")
        lock_path = self.state / "deploy.lock"
        if lock_path.exists() or lock_path.is_symlink():
            checked_path(lock_path, kind="file")
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise UpdateError("another deployment or update is active") from error
            require(not (self.state / "active.json").exists(), "previous application deployment requires recovery")
            for path in (self.release, self.pending):
                if path.exists() or path.is_symlink():
                    checked_path(path, kind="file")
            self.recover_pending()
            yield

    def synchronize(self, revision, expected_digest, initialize=False):
        validate_request(revision, expected_digest)
        with self.locked():
            return self.synchronize_locked(revision, expected_digest, initialize)

    def synchronize_locked(self, revision, expected_digest, initialize=False):
        """Caller holds locked(); shared with the administrator-only bootstrap installer."""
        validate_request(revision, expected_digest)
        previous = self.installed_release()
        require(previous is not None or initialize, "run the one-time administrator updater installation first")
        old_source = read_bytes(self.target, MAX_SOURCE_BYTES)
        old_digest = sha256(old_source)
        if previous is not None:
            require(previous["sha256"] == old_digest, "installed script differs from its trusted release record")
            if previous["revision"] == revision:
                require(expected_digest == old_digest, "requested hash differs from the installed release")
                return {"result": "unchanged", **previous}
        self.source.require_ancestor(revision, "master")
        if previous is not None:
            self.source.require_ancestor(previous["revision"], revision)
        source = self.source.read(revision)
        require(sha256(source) == expected_digest, "reviewed source SHA-256 does not match the requested version")
        try:
            compile(source, SOURCE_PATH, "exec")  # Parse only; never execute code during installation.
        except (SyntaxError, ValueError) as error:
            raise UpdateError("reviewed source is not valid Python for this interpreter") from error
        target = {"schema": 1, "revision": revision, "sha256": expected_digest}
        if previous is not None and old_digest == expected_digest:
            return {"result": "unchanged", **previous}
        self.records.mkdir(mode=0o700, exist_ok=True)
        checked_path(self.records, kind="directory")
        record = self.records / uuid.uuid4().hex
        record.mkdir(mode=0o700)
        atomic_write(record / "deploy.py.before", old_source)
        journal = {"record": record.name, "previous": previous, "target": target, "old_sha256": old_digest}
        write_json(record / "request.json", journal)
        sync_directory(self.records)
        write_json(self.pending, journal)
        try:
            atomic_write(self.target, source, 0o644)
            write_json(self.release, target)
            write_json(record / "result.json", {"result": "updated", "previous": previous, "target": target})
            self.pending.unlink()
            sync_directory(self.state)
        except Exception:
            self.recover_pending()
            raise
        return {"result": "updated", "record": str(record), **target}


def main():
    require(os.geteuid() == 0, "run through the installed sudo entry")
    os.umask(0o077)
    require(len(sys.argv) == 1, "command-line arguments are forbidden")

    def interrupted(*_):
        raise UpdateError("deployer update interrupted or exceeded 120 seconds")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(120)
    try:
        revision, digest = read_request(sys.stdin)
        result = Updater().synchronize(revision, digest)
        print(json.dumps(result), flush=True)
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except (UpdateError, OSError, ValueError, KeyError) as error:
        print("Deployer update failed: " + (str(error) if isinstance(error, UpdateError) else type(error).__name__),
              file=sys.stderr)
        sys.exit(1)
