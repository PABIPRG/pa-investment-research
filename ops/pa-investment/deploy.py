"""Root-only, single-instance deployment entry. No third-party Python dependencies."""

import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


REPOSITORY = "ghcr.io/pabiprg/pa-investment-research"
DEPLOY_DIR = Path("/home/admin/pa-investment-deploy")
BACKUP_DIR = Path("/home/admin/pa-investment-backups/controlled-deployments")
STATE_DIR = Path("/var/lib/pa-investment-deploy")
VOLUME = "pa-investment-research_dsh-data"
VOLUME_ROOT = Path("/var/lib/docker/volumes")
HEALTH_URL = "https://pair-demo.xiexin.dev/healthz"
REGISTRY_RUNTIME_DIR = Path("/run/pa-investment-deploy")
ENVIRONMENT = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
MAX_REQUEST_BYTES = 4096
HEALTHCHECK_COMMAND = ["/nodejs/bin/node", "/opt/container/investment-healthcheck.mjs"]
PULL_ATTEMPTS = 2
PULL_TIMEOUT_SECONDS = 900
PULL_RETRY_DELAY_SECONDS = 15
PULL_PROGRESS_INTERVAL_SECONDS = 60
ARTIFACT_DIR = Path("/home/admin/pa-investment-artifacts/objects")
SOURCE_LABEL = "https://github.com/PABIPRG/pa-investment-research"
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


class DeployError(RuntimeError):
    """A failed precondition or deployment step requiring operator attention."""


class CommandFailure(DeployError):
    """A command failed; only allowlisted metadata is safe to persist."""

    def __init__(self, message, kind, returncode=None):
        super().__init__(message)
        self.kind = kind
        self.returncode = returncode


class PullFailure(DeployError):
    """All bounded image-pull attempts failed before the service was stopped."""


def pull_failure_category(output):
    """Reduce untrusted Docker output to a fixed, credential-free error category."""
    lower = output.lower()
    for category, markers in (
        ("disk_full", (b"no space left on device",)),
        ("authentication", (b"unauthorized", b"authentication required", b"denied")),
        ("rate_limit", (b"toomanyrequests", b"rate limit")),
        ("unexpected_eof", (b"unexpected eof",)),
        ("network_timeout", (b"i/o timeout", b"tls handshake timeout",
                             b"connection timed out", b"context deadline exceeded")),
        ("connection_reset", (b"connection reset by peer",)),
    ):
        if any(marker in lower for marker in markers):
            return category
    return "unknown"


def require(condition, message):
    if not condition:
        raise DeployError(message)


def read_request(stream):
    value = stream.read(MAX_REQUEST_BYTES + 1)
    require(len(value.encode("utf-8")) <= MAX_REQUEST_BYTES and value.endswith("\n"),
            "invalid deployment request")
    lines = value.splitlines()
    require(len(lines) == 3, "invalid deployment request")
    image, username, token = lines
    require(re.fullmatch(re.escape(REPOSITORY) + r"@sha256:[0-9a-f]{64}", image),
            "invalid deployment image")
    require(re.fullmatch(r"[A-Za-z0-9_.@\[\]-]{1,128}", username),
            "invalid registry username")
    require(re.fullmatch(r"[\x21-\x7e]{20,1024}", token),
            "invalid registry credential")
    return image, username, token


def replace_image(text, image):
    candidates = re.findall(r"(?m)^[ \t]*(?:export[ \t]+)?DSH_IMAGE[ \t]*=.*$", text)
    require(len(candidates) == 1 and candidates[0].startswith("DSH_IMAGE="),
            ".env must have exactly one unindented DSH_IMAGE assignment")
    return re.sub(r"(?m)^DSH_IMAGE=.*$", lambda _: "DSH_IMAGE=" + image, text)


def atomic_write(path, text, mode=0o600, owner=None):
    fd, temporary = tempfile.mkstemp(prefix=".deploy-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), mode)
            if owner is not None:
                os.fchown(output.fileno(), *owner)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def write_json(path, value):
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_json(path):
    return json.loads(path.read_text())


def checked_path(path, owners, secret=False):
    """Reject links and writable ancestors; admin remains a trusted operator."""
    require(path.is_absolute(), "deployment path must be absolute")
    for entry in [*reversed(path.parents), path]:
        info = entry.lstat()
        require(not stat.S_ISLNK(info.st_mode), "symlink in deployment path: " + str(entry))
        allowed = owners | {10001} if secret and entry == path else owners
        require(info.st_uid in allowed and not info.st_mode & 0o022,
                "untrusted owner or writable deployment path: " + str(entry))
    return path.stat()


def success_timestamp(name, value):
    completed = value.get("completed_at")
    if completed is None:
        require(re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}", name), "invalid legacy success stamp")
        return datetime.datetime.strptime(name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
    timestamp = datetime.datetime.fromisoformat(completed)
    require(timestamp.tzinfo is not None, "success timestamp needs timezone")
    return timestamp


def retained_successes(records, current):
    """Select distinct verified versions, never Docker creation time or file mtime."""
    require(isinstance(current, str) and IMAGE_ID.fullmatch(current), "invalid current image ID")
    successes = []
    for name, value in records:
        require(isinstance(value, dict) and isinstance(value.get("phase"), str), "invalid deployment record")
        if value["phase"] != "complete":
            continue
        image = value.get("new_image_id", "")
        require(isinstance(image, str) and IMAGE_ID.fullmatch(image), "invalid successful image ID")
        successes.append((success_timestamp(name, value), name, image))
    require(any(item[2] == current for item in successes), "current image has no successful deployment record")
    kept = {current}
    for _, _, image in sorted(successes, reverse=True):
        kept.add(image)
        if len(kept) == 3:
            return kept
    raise DeployError("retention needs two successful historical versions; keep legacy images until verified")


def project_image(item):
    """Foreign aliases prevent ownership claims even when the source label matches."""
    refs = (item.get("RepoTags") or []) + (item.get("RepoDigests") or [])
    return (item.get("Config", {}).get("Labels", {}) or {}).get("org.opencontainers.image.source") == SOURCE_LABEL \
        and all(ref.startswith(REPOSITORY + ":") or ref.startswith(REPOSITORY + "@sha256:") for ref in refs)


def retention_path(path, owners):
    # /home/admin is a trusted ancestor, but state/records/objects themselves stay root-owned.
    info = checked_path(path, owners | {pwd.getpwnam("admin").pw_uid})
    require(info.st_uid in owners, "unexpected retention path owner")
    return info


def retention_file(path, owners):
    info = retention_path(path, owners)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "retention requires regular, unlinked files")
    return info


def retention_policy(state):
    path = state / "retention-policy.json"
    if not path.exists() and not path.is_symlink():
        return {"schema": 1, "mode": "dry-run", "protected_images": [], "config_roots": []}
    retention_file(path, {0})
    value = read_json(path)
    require(isinstance(value, dict) and set(value) == {"schema", "mode", "protected_images", "config_roots"}
            and value["schema"] == 1 and value["mode"] in {"dry-run", "apply"}, "invalid retention policy")
    for key in ("protected_images", "config_roots"):
        require(isinstance(value[key], list) and all(isinstance(item, str) for item in value[key]),
                "invalid retention policy list")
    for ref in value["protected_images"]:
        require(IMAGE_ID.fullmatch(ref) or re.fullmatch(re.escape(REPOSITORY) + r"@sha256:[0-9a-f]{64}", ref),
                "rollback pins must use full image IDs or repository digests")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def managed_artifacts(root):
    """Unknown objects are never recursively removed; incomplete imports stay visible."""
    if not root.exists() and not root.is_symlink():
        return []
    retention_path(root, {0})
    result = []
    for directory in sorted(root.iterdir()):
        if directory.name.startswith(".import-"):
            continue  # Interrupted copy; administrator can inspect it, never infer expiry.
        retention_path(directory, {0})
        require(directory.is_dir() and re.fullmatch(r"[0-9a-f]{64}", directory.name), "unknown artifact object")
        require({path.name for path in directory.iterdir()} == {"archive.tar.gz", "metadata.json"},
                "unknown artifact contents")
        for name in ("archive.tar.gz", "metadata.json"):
            retention_file(directory / name, {0})
        metadata = read_json(directory / "metadata.json")
        require(set(metadata) == {"schema", "sha256", "image_id", "imported_at"} and metadata["schema"] == 1
                and metadata["sha256"] == directory.name and IMAGE_ID.fullmatch(metadata["image_id"]),
                "invalid artifact metadata")
        imported = datetime.datetime.fromisoformat(metadata["imported_at"])
        require(imported.tzinfo is not None, "artifact timestamp needs timezone")
        result.append((directory, metadata, imported))
    return result


def transact(image, state, driver):
    """A durable marker survives crashes; only a completed run removes it."""
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / "deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeployError("another deployment is active") from error
        active = state / "active.json"
        require(not active.exists(), "previous deployment requires recovery; inspect " + str(active))
        require(not (state / "deployer-update-pending.json").exists(),
                "unfinished deployer update; run the fixed updater to recover before deploying")
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        record = driver.record_root if hasattr(driver, "record_root") else state
        record = record / (stamp + "-" + uuid.uuid4().hex[:12])
        record.mkdir(mode=0o700)
        status = {"image": image, "record": str(record), "phase": "preparing"}

        def phase(name):
            status["phase"] = name
            write_json(record / "status.json", status)
            write_json(active, status)
            print(json.dumps({"phase": name, "record": str(record)}), flush=True)

        phase("preparing")
        try:
            status.update(driver.prepare(image, record))
            phase("stopping")
            driver.stop()
            phase("backing-up")
            driver.backup(record)
            phase("switching")
            driver.switch(image)
            phase("starting")
            driver.start()
            phase("verifying")
            driver.verify(image)
            status["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            phase("complete")
            active.unlink()
            directory = os.open(state, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException as error:
            # Diagnostics never include .env, Docker Config.Env, or a full inspect.
            status["failed_phase"] = status["phase"]
            status["error_type"] = type(error).__name__
            if isinstance(error, DeployError):
                status["reason"] = str(error)
            phase("recovery-required")
            diagnostics_available = False
            try:
                driver.diagnose(record)
                diagnostics_available = True
            except Exception:
                print("diagnostics unavailable; recovery marker retained", file=sys.stderr)
            if status["failed_phase"] == "preparing" and isinstance(error, PullFailure) and diagnostics_available:
                try:
                    evidence = driver.verify_unchanged_after_failed_pull()
                    write_json(record / "prepare-failure-disposition.json", {
                        "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        "reason": status["reason"], "evidence": evidence,
                    })
                    phase("prepare-failed-safe")
                    active.unlink()
                    directory = os.open(state, os.O_RDONLY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                except Exception:
                    print("old service could not be reverified; recovery marker retained", file=sys.stderr)
            raise
        # Do not let cleanup errors enter the deployment recovery path after commit.
        if hasattr(driver, "cleanup"):
            try:
                write_json(record / "cleanup.json", {"result": "running"})
                result = driver.cleanup(state, record)
                write_json(record / "cleanup.json", result)
                print(json.dumps({"phase": "retention", "result": result["result"], "record": str(record)}), flush=True)
            except BaseException as error:
                with contextlib.suppress(Exception):
                    report = read_json(record / "cleanup.json") if (record / "cleanup.json").exists() else {}
                    report.update({"result": "failed", "error_type": type(error).__name__})
                    write_json(record / "cleanup.json", report)
                print("deployment complete; retention failed or interrupted; inspect cleanup.json", file=sys.stderr)
        return record


class DockerDriver:
    def __init__(self, registry_username, registry_token):
        self.record_root = BACKUP_DIR
        self.registry_username = registry_username
        self.registry_token = registry_token
        self.compose = ["docker", "compose", "--project-directory", str(DEPLOY_DIR),
                        "--env-file", str(DEPLOY_DIR / ".env"), "-f", str(DEPLOY_DIR / "compose.yaml"),
                        "-p", "pa-investment-research"]

    def run(self, args, timeout=120, input_text=None, environment=None,
            progress_interval=None, progress_event=None, progress_summary=None):
        if progress_interval is not None:
            require(input_text is None and progress_interval > 0 and progress_event is not None,
                    "invalid command progress configuration")
            # Read Docker's output so we can tell whether its CLI is active, but never
            # print or persist it: it may contain registry URLs or credentials.
            summary = progress_summary if progress_summary is not None else {}
            summary["cli_output_bytes"] = 0
            process = subprocess.Popen(args, env=environment or ENVIRONMENT, cwd="/",
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT)
            started = time.monotonic()
            last_output = started
            output_tail = b""
            next_heartbeat = started + progress_interval
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while True:
                        now = time.monotonic()
                        if now >= started + timeout:
                            summary["cli_idle_seconds"] = round(now - last_output, 2)
                            summary["failure_category"] = ("no_cli_output" if not summary["cli_output_bytes"]
                                                           else pull_failure_category(output_tail))
                            raise CommandFailure("command timed out after " + str(timeout) + "s: " +
                                                 args[0] + " " + args[1], "timeout")
                        events = selector.select(max(0, min(next_heartbeat, started + timeout) - now))
                        if events:
                            chunk = os.read(process.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            summary["cli_output_bytes"] += len(chunk)
                            last_output = time.monotonic()
                            output_tail = (output_tail + chunk)[-16384:]
                        now = time.monotonic()
                        if now >= next_heartbeat:
                            print(json.dumps({**progress_event,
                                              "elapsed_seconds": round(now - started, 2),
                                              "timeout_seconds": timeout,
                                              "cli_output_bytes": summary["cli_output_bytes"],
                                              "cli_idle_seconds": round(now - last_output, 2)}), flush=True)
                            next_heartbeat = now + progress_interval
                returncode = process.wait()
                summary["cli_idle_seconds"] = round(time.monotonic() - last_output, 2)
                if returncode:
                    summary["failure_category"] = ("no_cli_output" if not summary["cli_output_bytes"]
                                                   else pull_failure_category(output_tail))
                    raise CommandFailure("command exit " + str(returncode) + ": " +
                                         args[0] + " " + args[1], "exit", returncode)
                return ""
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
        try:
            result = subprocess.run(args, env=environment or ENVIRONMENT, cwd="/", capture_output=True,
                                    text=True, input=input_text, timeout=timeout, check=True)
        except subprocess.TimeoutExpired as error:
            # stderr may contain interpolated application secrets; retain no raw output.
            raise CommandFailure("command timed out after " + str(timeout) + "s: " + args[0] + " " + args[1],
                                 "timeout") from error
        except subprocess.CalledProcessError as error:
            raise CommandFailure("command exit " + str(error.returncode) + ": " + args[0] + " " + args[1],
                                 "exit", error.returncode) from error
        return result.stdout.strip()

    def pull_private_image(self, image, record):
        token = self.registry_token
        self.registry_token = None
        require(token is not None, "registry credential already consumed")
        with tempfile.TemporaryDirectory(prefix="registry-", dir=REGISTRY_RUNTIME_DIR) as directory:
            os.chmod(directory, 0o700)
            environment = {**ENVIRONMENT, "DOCKER_CONFIG": directory}
            self.run(["docker", "login", "ghcr.io", "--username", self.registry_username,
                      "--password-stdin"], input_text=token + "\n", environment=environment)
            attempts = []
            for attempt in range(1, PULL_ATTEMPTS + 1):
                started = time.monotonic()
                started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
                print(json.dumps({"phase": "pull-start", "attempt": attempt,
                                  "timeout_seconds": PULL_TIMEOUT_SECONDS,
                                  "at_utc": started_at}), flush=True)
                attempts.append({"attempt": attempt, "result": "running",
                                 "started_at_utc": started_at})
                write_json(record / "image-pull.json", {"image": image, "attempts": attempts})
                activity = {}
                try:
                    self.run(["docker", "pull", image], timeout=PULL_TIMEOUT_SECONDS,
                             environment=environment,
                             progress_interval=PULL_PROGRESS_INTERVAL_SECONDS,
                             progress_event={"phase": "pull-heartbeat", "attempt": attempt},
                             progress_summary=activity)
                except CommandFailure as error:
                    event = {"attempt": attempt, "result": getattr(error, "kind", "error"),
                             "elapsed_seconds": round(time.monotonic() - started, 2),
                             "started_at_utc": started_at,
                             "finished_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             **activity}
                    if error.returncode is not None:
                        event["exit_code"] = error.returncode
                    attempts[-1] = event
                    write_json(record / "image-pull.json", {"image": image, "attempts": attempts})
                    print(json.dumps({"phase": "pull-result", **event}), flush=True)
                    if attempt == PULL_ATTEMPTS:
                        raise PullFailure("docker pull failed after " + str(attempt) +
                                          " attempts; last result: " + str(error)) from error
                    print(json.dumps({"phase": "pull-retry", **event}), flush=True)
                    time.sleep(PULL_RETRY_DELAY_SECONDS)
                else:
                    event = {"attempt": attempt, "result": "success",
                             "elapsed_seconds": round(time.monotonic() - started, 2),
                             "started_at_utc": started_at,
                             "finished_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             **activity}
                    attempts[-1] = event
                    write_json(record / "image-pull.json", {"image": image, "attempts": attempts})
                    print(json.dumps({"phase": "pull-result", **event}), flush=True)
                    return

    def inspect(self, reference, kind="container"):
        values = json.loads(self.run(["docker", kind, "inspect", reference]))
        require(len(values) == 1, "expected one inspected object")
        return values[0]

    def container(self):
        ids = self.run(self.compose + ["ps", "-a", "-q", "investment"]).split()
        require(len(ids) == 1, "expected exactly one existing investment container")
        return self.inspect(ids[0])

    def volume_users(self):
        return self.run(["docker", "ps", "-q", "--no-trunc", "--filter", "volume=" + VOLUME]).split()

    def prepare(self, image, record):
        admin = pwd.getpwnam("admin").pw_uid
        for name in ["compose.yaml", ".env", "web-admin-password.hash"]:
            info = checked_path(DEPLOY_DIR / name, {0, admin}, secret=name.endswith(".hash"))
            require(stat.S_ISREG(info.st_mode), "deployment configuration must be regular files")
            if name == ".env":
                require(not info.st_mode & 0o077, ".env must be private to its owner")
            if name.endswith(".hash"):
                require(info.st_uid == 10001 and stat.S_IMODE(info.st_mode) == 0o400,
                        "password hash must be owned by UID 10001 with mode 0400")
        self.before = (DEPLOY_DIR / ".env").read_text()
        self.after = replace_image(self.before, image)
        config = json.loads(self.run(self.compose + ["config", "--format", "json"]))
        self.initial_config = config
        service = config["services"]["investment"]
        healthcheck = service.get("healthcheck") or {}
        require(not healthcheck.get("disable")
                and healthcheck.get("test") == ["CMD", *HEALTHCHECK_COMMAND],
                "incompatible Compose healthcheck; expected CMD /nodejs/bin/node "
                "/opt/container/investment-healthcheck.mjs")
        require(not service.get("privileged") and not service.get("devices"), "privileged service rejected")
        require(service.get("read_only") and "ALL" in service.get("cap_drop", []), "runtime hardening missing")
        mounts = service.get("volumes", [])
        require(len(mounts) == 1 and mounts[0].get("type") == "volume"
                and mounts[0].get("target") == "/var/lib/dsh"
                and config["volumes"][mounts[0]["source"]]["name"] == VOLUME,
                "unexpected persistent volume mapping")
        require(any(config.get("networks", {}).get(name, {}).get("name", name) == "1panel-network"
                    for name in service.get("networks", {})), "existing 1Panel network missing")
        self.old = self.container()
        require(self.old["State"].get("Running") and self.old["State"].get("Health", {}).get("Status") == "healthy",
                "current service must be running and healthy")
        require(self.volume_users() == [self.old["Id"]], "another container uses the production volume")
        require(self.old["Config"]["Image"] == service["image"], "Compose and running image differ")
        mounted = [m for m in self.old["Mounts"] if m["Destination"] == "/var/lib/dsh"]
        require(len(mounted) == 1 and mounted[0].get("Name") == VOLUME, "running volume differs")
        volume = self.inspect(VOLUME, "volume")
        require(volume["Driver"] == "local" and not volume.get("Options"), "only local Docker volumes supported")
        self.volume_path = Path(volume["Mountpoint"])
        require(self.volume_path == VOLUME_ROOT / VOLUME / "_data",
                "unexpected Docker volume root")
        checked_path(self.volume_path.parent, {0})
        require(not self.volume_path.is_symlink() and self.volume_path.is_dir(), "invalid data root")
        size = int(self.run(["du", "-sb", str(self.volume_path)]).split()[0])
        self.backup_required_bytes = size * 2 + 1024 ** 3
        require(shutil.disk_usage(record).free > self.backup_required_bytes, "insufficient backup space")
        self.pull_private_image(image, record)
        candidate = self.inspect(image, "image")
        require(candidate.get("Os") == "linux" and candidate.get("Architecture") == "amd64",
                "candidate must be linux/amd64")
        require(candidate["Config"].get("User") == "10001:10001",
                "candidate must run as 10001:10001")
        labels = candidate["Config"].get("Labels", {})
        require(labels.get("org.opencontainers.image.source") == "https://github.com/PABIPRG/pa-investment-research",
                "candidate source label differs")
        revision = labels.get("org.opencontainers.image.revision", "")
        require(re.fullmatch(r"[0-9a-f]{40}", revision), "candidate revision missing")
        require(shutil.disk_usage(record).free > self.backup_required_bytes,
                "insufficient backup space after image pull")
        self.new_id = candidate["Id"]
        return {"old_image": self.old["Config"]["Image"], "old_image_id": self.old["Image"],
                "new_image_id": self.new_id, "revision": revision, "volume": VOLUME}

    def verify_unchanged_after_failed_pull(self):
        require(all(hasattr(self, name) for name in ("old", "before", "initial_config", "backup_required_bytes")),
                "old service was not captured before image pull")
        require((DEPLOY_DIR / ".env").read_text() == self.before,
                "configuration changed during image pull")
        require(json.loads(self.run(self.compose + ["config", "--format", "json"])) == self.initial_config,
                "Compose configuration changed during image pull")
        current = self.container()
        require(current["Id"] == self.old["Id"] and current["Image"] == self.old["Image"]
                and current["Config"]["Image"] == self.old["Config"]["Image"],
                "old container identity changed during image pull")
        require(current["State"].get("Running")
                and current["State"].get("Health", {}).get("Status") == "healthy",
                "old service is not running and healthy after image pull")
        require(self.volume_users() == [self.old["Id"]],
                "production volume writers changed during image pull")
        require(shutil.disk_usage(self.record_root).free > self.backup_required_bytes,
                "insufficient backup space after failed image pull")
        response = self.run(["curl", "--fail", "--silent", "--show-error", "--proto", "=https",
                             "--max-time", "30", HEALTH_URL])
        require(json.loads(response).get("status") == "ok", "HTTPS healthz did not return ok")
        return {"container_id": current["Id"], "old_image": current["Config"]["Image"],
                "old_image_id": current["Image"], "health": "healthy", "public_health": "ok"}

    def stop(self):
        self.run(self.compose + ["stop", "--timeout", "30", "investment"])
        stopped = self.inspect(self.old["Id"])
        require(not stopped["State"]["Running"] and stopped["State"]["ExitCode"] == 0,
                "service did not stop gracefully")
        require(not self.volume_users(), "volume still has a running writer")

    def backup(self, record):
        for name in ["compose.yaml", ".env", "web-admin-password.hash"]:
            target = record / name
            with (DEPLOY_DIR / name).open("rb") as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
        archive = record / "dsh-data.tar.gz"
        self.run(["tar", "--acls", "--xattrs", "--numeric-owner", "--one-file-system", "-czpf",
                  str(archive), "-C", str(self.volume_path), "."], timeout=1800)
        self.run(["tar", "-tzf", str(archive)], timeout=600)
        hashes = {}
        for name in ["compose.yaml", ".env", "web-admin-password.hash", "dsh-data.tar.gz"]:
            digest = hashlib.sha256()
            with (record / name).open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                os.fsync(stream.fileno())
            hashes[name] = digest.hexdigest()
        write_json(record / "backup-sha256.json", hashes)
        require(not self.volume_users(), "unexpected writer during backup")

    def switch(self, image):
        require((DEPLOY_DIR / ".env").read_text() == self.before, "configuration changed during deployment")
        info = (DEPLOY_DIR / ".env").stat()
        atomic_write(DEPLOY_DIR / ".env", self.after, stat.S_IMODE(info.st_mode), (info.st_uid, info.st_gid))

    def start(self):
        self.run(self.compose + ["up", "-d", "--no-build", "--no-deps", "--pull", "never",
                                 "--force-recreate", "investment"], timeout=180)

    def verify(self, image):
        for _ in range(90):
            container = self.container()
            require(container["Image"] == self.new_id and container["Config"]["Image"] == image,
                    "running image identity differs")
            require(container["State"]["Running"], "new service exited")
            health = container["State"].get("Health", {}).get("Status")
            require(health != "unhealthy", "new service unhealthy")
            if health == "healthy":
                break
            time.sleep(5)
        else:
            raise DeployError("health wait expired")
        require(self.volume_users() == [container["Id"]], "single-instance check failed")
        self.run(["docker", "exec", container["Id"], *HEALTHCHECK_COMMAND])
        response = self.run(["curl", "--fail", "--silent", "--show-error", "--proto", "=https",
                             "--max-time", "30", HEALTH_URL])
        require(json.loads(response).get("status") == "ok", "HTTPS healthz did not return ok")

    def diagnose(self, record):
        container = self.container()
        state = container["State"]
        write_json(record / "diagnostics.json", {
            "container": container["Id"], "image_id": container["Image"],
            "status": state.get("Status"), "exit_code": state.get("ExitCode"),
            "health": state.get("Health", {}).get("Status"),
            "restart_count": container.get("RestartCount"),
        })
        # Application logs may contain private data: retain only on the server.
        with (record / "container.log").open("w") as output:
            subprocess.run(["docker", "logs", "--tail", "200", container["Id"]], env=ENVIRONMENT,
                           cwd="/", stdout=output, stderr=output, timeout=30, check=False)

    def configured_images(self, policy):
        """Read active and saved configurations; any unresolved reference stops cleanup."""
        owners = {0, pwd.getpwnam("admin").pw_uid}
        refs = set()
        fingerprints = {}
        roots = {DEPLOY_DIR, *(Path(value) for value in policy["config_roots"])}
        for root in sorted(roots):
            require(root.is_absolute() and root != Path("/") and ".." not in root.parts,
                    "invalid configuration root")
            checked_path(root, owners)
            require(root.is_dir(), "configuration root is not a directory")
            def walk_error(error):
                raise error
            for directory, children, files in os.walk(root, followlinks=False, onerror=walk_error):
                for name in children:
                    checked_path(Path(directory) / name, owners)
                for name in files:
                    path = Path(directory) / name
                    env_file = name == ".env" or name.startswith(".env.") or name.endswith(".env")
                    compose_file = (name.startswith("compose") or name.startswith("docker-compose")) \
                        and path.suffix in {".yaml", ".yml"}
                    if not (env_file or compose_file):
                        continue
                    retention_file(path, owners)
                    require(path.stat().st_size <= 1024 * 1024, "configuration exceeds retention limit")
                    fingerprints[str(path)] = sha256_file(path)
                    if env_file:
                        for line in path.read_text().splitlines():
                            if re.match(r"\s*(?:export\s+)?DSH_IMAGE\s*=", line):
                                tokens = shlex.split(line.split("=", 1)[1], comments=True)
                                require(len(tokens) == 1 and not re.search(r"[$`\s]", tokens[0]),
                                        "unresolved image assignment; pin literal image identity")
                                refs.add(tokens[0])
                    if compose_file:
                        args = ["docker", "compose", "--project-directory", str(path.parent)]
                        env = path.parent / ".env"
                        if env.exists():
                            retention_file(env, owners)
                            args += ["--env-file", str(env)]
                        # Render actual Compose semantics, including literal images and interpolation.
                        rendered = json.loads(self.run(args + ["-f", str(path), "config", "--format", "json"]))
                        for service in rendered["services"].values():
                            require(isinstance(service.get("image"), str) and service["image"],
                                    "configuration has unresolved service image")
                            refs.add(service["image"])
        require(str(DEPLOY_DIR / ".env") in fingerprints and str(DEPLOY_DIR / "compose.yaml") in fingerprints,
                "active configuration missing")
        return refs, fingerprints

    def retention_snapshot(self, state, verify_archives=True):
        require(not (state / "active.json").exists() and not (state / "active.json").is_symlink(),
                "active deployment blocks retention")
        require(not (state / "deployer-update-pending.json").exists()
                and not (state / "deployer-update-pending.json").is_symlink(), "pending updater blocks retention")
        policy = retention_policy(state)
        current = self.container()
        require(current["State"].get("Running") and current["State"].get("Health", {}).get("Status") == "healthy",
                "current container must be healthy for retention")
        records = []
        for directory in self.record_root.iterdir():
            retention_path(directory, {0})
            require(directory.is_dir(), "unknown deployment record")
            path = directory / "status.json"
            retention_file(path, {0})
            records.append((directory.name, read_json(path)))
        protected = retained_successes(records, current["Image"])
        refs, fingerprints = self.configured_images(policy)
        for ref in set(policy["protected_images"]) | refs:
            protected.add(self.inspect(ref, "image")["Id"])
        for identifier in self.run(["docker", "ps", "-aq", "--no-trunc"]).split():
            protected.add(self.inspect(identifier)["Image"])
        # The previous running image remains a recovery option even if its legacy success was not recorded.
        latest = max((entry for entry in records if entry[1].get("new_image_id") == current["Image"]
                      and entry[1]["phase"] == "complete"),
                     key=lambda entry: (success_timestamp(*entry), entry[0]))[1]
        if latest.get("old_image_id"):
            protected.add(latest["old_image_id"])
        require(all(isinstance(value, str) and IMAGE_ID.fullmatch(value) for value in protected),
                "invalid protected image ID")
        # Missing recovery images must not silently reduce the required history.
        for identifier in protected:
            require(self.inspect(identifier, "image")["Id"] == identifier, "protected image unavailable")
        now = datetime.datetime.now(datetime.timezone.utc)
        objects = managed_artifacts(ARTIFACT_DIR)
        for _, metadata, imported in objects:
            if now - imported < datetime.timedelta(days=7):
                # Imported archives may not have been docker-loaded yet; no inspect required.
                protected.add(metadata["image_id"])
        images = {}
        for identifier in set(self.run(["docker", "image", "ls", "-aq", "--no-trunc"]).split()):
            item = self.inspect(identifier, "image")
            require(item["Id"] == identifier, "image identity changed")
            if project_image(item) and identifier not in protected:
                images[identifier] = sorted((item.get("RepoTags") or []) + (item.get("RepoDigests") or []))
        artifacts = []
        for directory, metadata, imported in objects:
            if metadata["image_id"] not in protected and now - imported >= datetime.timedelta(days=7):
                if verify_archives:
                    require(sha256_file(directory / "archive.tar.gz") == metadata["sha256"], "artifact checksum drift")
                artifacts.append(directory.name)
        return {"policy": policy, "current": current["Id"], "protected": sorted(protected),
                "configurations": fingerprints, "images": images, "artifacts": sorted(artifacts)}

    def cleanup(self, state, record):
        """Caller owns deploy.lock. Recheck the entire protection boundary before each mutation."""
        snapshot = self.retention_snapshot(state)
        result = {"result": "dry-run" if snapshot["policy"]["mode"] == "dry-run" else "running",
                  "protected": snapshot["protected"], "candidate_images": sorted(snapshot["images"]),
                  "candidate_artifacts": snapshot["artifacts"], "removed_images": [], "removed_artifacts": [],
                  "errors": []}
        write_json(record / "cleanup.json", result)
        if snapshot["policy"]["mode"] == "dry-run":
            return result

        def recheck():
            fresh = self.retention_snapshot(state, verify_archives=False)
            for key in ("policy", "current", "protected", "configurations"):
                require(fresh[key] == snapshot[key], "retention protection changed; retry after review")
            return fresh

        for identifier, original_refs in sorted(snapshot["images"].items()):
            try:
                fresh = recheck()
                require(fresh["images"].get(identifier) == original_refs, "candidate references changed")
                # Tags are removed individually without force. All stopped/running users were protected above.
                tags = [ref for ref in original_refs if "@sha256:" not in ref]
                targets = tags or original_refs or [identifier]
                for target in targets:
                    fresh = recheck()
                    require(identifier in fresh["images"], "candidate became protected")
                    require(self.inspect(target, "image")["Id"] == identifier, "image reference moved")
                    self.run(["docker", "image", "rm", "--no-prune", target])
                require(identifier not in self.run(["docker", "image", "ls", "-aq", "--no-trunc"]).split(),
                        "image still has references after removal")
                result["removed_images"].append(identifier)
            except Exception as error:
                result["errors"].append({"image_id": identifier, "error_type": type(error).__name__})
                # Stop at the first race/error; keep archives available for recovery.
                break
            finally:
                write_json(record / "cleanup.json", result)
        if not result["errors"]:
            for digest in snapshot["artifacts"]:
                fresh = recheck()
                require(digest in fresh["artifacts"], "artifact became protected")
                directory = ARTIFACT_DIR / digest
                require(sha256_file(directory / "archive.tar.gz") == digest, "artifact changed before removal")
                # Exact files only. Interrupted cleanup leaves a visible, non-deletable object for review.
                (directory / "archive.tar.gz").unlink()
                (directory / "metadata.json").unlink()
                directory.rmdir()
                result["removed_artifacts"].append(digest)
                write_json(record / "cleanup.json", result)
        result["result"] = "partial" if result["errors"] else "complete"
        return result


def main():
    require(len(sys.argv) == 1, "command-line arguments are forbidden")
    require(os.geteuid() == 0, "run through the installed sudo entry")
    os.umask(0o077)
    image, registry_username, registry_token = read_request(sys.stdin)
    admin = pwd.getpwnam("admin").pw_uid
    checked_path(STATE_DIR, {0})
    checked_path(BACKUP_DIR, {0, admin})
    require(STATE_DIR.stat().st_uid == 0 and BACKUP_DIR.stat().st_uid == 0,
            "state and backup directories must be root-owned")
    REGISTRY_RUNTIME_DIR.mkdir(mode=0o700, exist_ok=True)
    runtime = checked_path(REGISTRY_RUNTIME_DIR, {0})
    require(runtime.st_uid == 0 and stat.S_IMODE(runtime.st_mode) == 0o700,
            "registry runtime directory must be root-owned with mode 0700")
    def interrupted(*_):
        raise DeployError("deployment interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    transact(image, STATE_DIR, DockerDriver(registry_username, registry_token))


if __name__ == "__main__":
    try:
        main()
    except (DeployError, OSError, ValueError, KeyError) as error:
        # Avoid serializing exception payloads from parsed configuration or commands.
        print("Deployment failed (" + type(error).__name__ +
              "). Inspect the deployment record and /var/lib/pa-investment-deploy/active.json if present.",
              file=sys.stderr)
        if isinstance(error, DeployError):
            print(str(error), file=sys.stderr)
        sys.exit(1)
