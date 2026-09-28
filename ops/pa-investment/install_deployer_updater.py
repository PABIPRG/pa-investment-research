"""Administrator-only bootstrap for aly; keeps its existing deploy wrapper and sudoers."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import uuid


ENVIRONMENT = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
TARGETS = {
    "update_deployer.py": (Path("/usr/local/libexec/pa-investment/update_deployer.py"), 0o644),
    "pa-investment-update-deployer": (Path("/usr/local/sbin/pa-investment-update-deployer"), 0o755),
    "pa-investment-update-deployer.sudoers": (Path("/etc/sudoers.d/pa-investment-update-deployer"), 0o440),
}


def visudo(rule=None):
    command = ["/usr/sbin/visudo", "-cf", str(rule)] if rule else ["/usr/sbin/visudo", "-c"]
    subprocess.run(command, check=True, timeout=30, cwd="/", env=ENVIRONMENT)


def install(updater, controller, source_dir, revision, targets=TARGETS, check_sudo=visudo):
    reviewed = {}
    for name, (destination, mode) in targets.items():
        source = source_dir / name
        updater.require(source.is_file() and not source.is_symlink(), "missing reviewed installation file")
        reviewed[name] = source.read_bytes()
        updater.checked_path(destination.parent, kind="directory")
        if destination.exists() or destination.is_symlink():
            updater.checked_path(destination, kind="file")
    expected = updater.sha256((source_dir / "deploy.py").read_bytes())
    updater.validate_request(revision, expected)
    check_sudo(source_dir / "pa-investment-update-deployer.sudoers")
    check_sudo()
    with controller.locked():
        records = controller.state / "installation-backups"
        records.mkdir(mode=0o700, exist_ok=True)
        updater.checked_path(records, kind="directory")
        record = records / ("updater-" + uuid.uuid4().hex)
        record.mkdir(mode=0o700)
        paths = [(controller.target, 0o644), (controller.release, 0o600), *targets.values()]
        snapshots = []
        for index, (path, default_mode) in enumerate(paths):
            exists = path.exists()
            if exists:
                info = updater.checked_path(path, kind="file")
                content = updater.read_bytes(path, updater.MAX_SOURCE_BYTES)
                mode = stat.S_IMODE(info.st_mode)
                updater.atomic_write(record / str(index), content)
            else:
                content, mode = None, default_mode
            snapshots.append((path, content, mode))
        updater.write_json(record / "files.json", [
            {"path": str(path), "backup": str(index) if content is not None else None, "mode": mode,
             "sha256": updater.sha256(content) if content is not None else None}
            for index, (path, content, mode) in enumerate(snapshots)])
        updater.sync_directory(records)
        try:
            controller.synchronize_locked(revision, expected, initialize=True)
            # Enable sudo last: all executable files and release metadata already exist.
            for name, (destination, mode) in targets.items():
                updater.atomic_write(destination, reviewed[name], mode)
            check_sudo()
            updater.write_json(record / "result.json", {"result": "installed", "revision": revision})
        except Exception:
            # No app/container changes occur here. Restore the former files under the same lock.
            controller.recover_pending()
            for path, content, mode in reversed(snapshots):
                if content is None:
                    if path.exists():
                        path.unlink()
                        updater.sync_directory(path.parent)
                else:
                    updater.atomic_write(path, content, mode)
            updater.write_json(record / "result.json", {"result": "rolled-back", "revision": revision})
            raise
    return {"result": "installed", "revision": revision, "sha256": expected, "backup": str(record)}


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise RuntimeError("Run as administrator with the reviewed full commit SHA")
    os.environ.clear()
    os.environ.update(ENVIRONMENT)
    os.umask(0o077)
    source_dir = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("reviewed_updater", source_dir / "update_deployer.py")
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    updater.require(sys.version_info[:2] == (3, 11), "use aly's existing /usr/bin/python3.11")
    wrapper = Path("/usr/local/sbin/pa-investment-deploy")
    updater.checked_path(wrapper, kind="file")
    updater.require(b"/usr/bin/python3.11" in wrapper.read_bytes(), "existing deploy wrapper must use Python 3.11")
    updater.checked_path(Path("/etc/sudoers.d/pa-investment-deploy"), kind="file")

    def interrupted(*_):
        raise RuntimeError("updater installation interrupted or timed out")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(180)
    try:
        result = install(updater, updater.Updater(), source_dir, sys.argv[1])
        print(json.dumps(result), flush=True)
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Updater installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
