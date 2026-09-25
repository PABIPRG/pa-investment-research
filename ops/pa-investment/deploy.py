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
            phase("complete")
            active.unlink()
            directory = os.open(state, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return record
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


class DockerDriver:
    def __init__(self, registry_username, registry_token):
        self.record_root = BACKUP_DIR
        self.registry_username = registry_username
        self.registry_token = registry_token
        self.compose = ["docker", "compose", "--project-directory", str(DEPLOY_DIR),
                        "--env-file", str(DEPLOY_DIR / ".env"), "-f", str(DEPLOY_DIR / "compose.yaml"),
                        "-p", "pa-investment-research"]

    def run(self, args, timeout=120, input_text=None, environment=None,
            progress_interval=None, progress_event=None):
        if progress_interval is not None:
            require(input_text is None and progress_interval > 0 and progress_event is not None,
                    "invalid command progress configuration")
            # Docker may print registry URLs or other unreviewed content. Only emit our own
            # fixed metadata while it runs; the exit code remains available on failure.
            process = subprocess.Popen(args, env=environment or ENVIRONMENT, cwd="/",
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
            started = time.monotonic()
            try:
                while True:
                    remaining = timeout - (time.monotonic() - started)
                    if remaining <= 0:
                        raise CommandFailure("command timed out after " + str(timeout) + "s: " +
                                             args[0] + " " + args[1], "timeout")
                    try:
                        returncode = process.wait(timeout=min(progress_interval, remaining))
                    except subprocess.TimeoutExpired:
                        print(json.dumps({**progress_event,
                                          "elapsed_seconds": round(time.monotonic() - started, 2),
                                          "timeout_seconds": timeout}), flush=True)
                        continue
                    if returncode:
                        raise CommandFailure("command exit " + str(returncode) + ": " +
                                             args[0] + " " + args[1], "exit", returncode)
                    return ""
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
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
                try:
                    self.run(["docker", "pull", image], timeout=PULL_TIMEOUT_SECONDS,
                             environment=environment,
                             progress_interval=PULL_PROGRESS_INTERVAL_SECONDS,
                             progress_event={"phase": "pull-heartbeat", "attempt": attempt})
                except CommandFailure as error:
                    event = {"attempt": attempt, "result": getattr(error, "kind", "error"),
                             "elapsed_seconds": round(time.monotonic() - started, 2),
                             "started_at_utc": started_at,
                             "finished_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
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
                             "finished_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
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
