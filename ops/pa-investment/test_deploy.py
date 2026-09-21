"""Deployment regression tests use temporary files and a fake container driver."""

import io
import contextlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import deploy


IMAGE = "ghcr.io/pabiprg/pa-investment-research@sha256:" + "a" * 64


class InputTests(unittest.TestCase):
    def test_exact_digest_line(self):
        self.assertEqual(deploy.read_image(io.StringIO(IMAGE + "\n")), IMAGE)

    def test_rejects_tags_other_registries_and_extra_input(self):
        for value in [IMAGE + "\n\n", IMAGE + "\necho bad\n", IMAGE + " ",
                      IMAGE.replace("pabiprg", "other"), IMAGE.replace("a" * 64, "A" * 64),
                      "ghcr.io/pabiprg/pa-investment-research:latest", "$(id)", ""]:
            with self.subTest(value=value), self.assertRaises(deploy.DeployError):
                deploy.read_image(io.StringIO(value))

    def test_updates_one_assignment_without_changing_other_settings(self):
        before = "# unchanged\nTZ=Asia/Shanghai\n\nDSH_IMAGE=old\nSECRET=opaque\n"
        after = deploy.replace_image(before, IMAGE)
        self.assertEqual(after, before.replace("DSH_IMAGE=old", "DSH_IMAGE=" + IMAGE))

    def test_missing_duplicate_or_exported_assignment_is_rejected(self):
        for value in ["TZ=UTC\n", "DSH_IMAGE=a\nDSH_IMAGE=b\n", "export DSH_IMAGE=a\n",
                      " DSH_IMAGE=a\n", "DSH_IMAGE=a\nexport DSH_IMAGE=b\n"]:
            with self.subTest(value=value), self.assertRaises(deploy.DeployError):
                deploy.replace_image(value, IMAGE)


class FakeDriver:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def step(self, name):
        self.calls.append(name)
        if name == self.fail:
            raise deploy.DeployError("injected failure")

    def prepare(self, image, record):
        self.step("prepare")
        return {"old_image": "sha256:" + "b" * 64, "revision": "c" * 40}

    def stop(self):
        self.step("stop")

    def backup(self, record):
        self.step("backup")

    def switch(self, image):
        self.step("switch")

    def start(self):
        self.step("start")

    def verify(self, image):
        self.step("verify")

    def diagnose(self, record):
        self.calls.append("diagnose")


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def run_transaction(self, driver):
        return deploy.transact(IMAGE, self.root, driver)

    def test_success_records_backup_and_clears_active_marker(self):
        driver = FakeDriver()
        record = self.run_transaction(driver)
        self.assertEqual(driver.calls, ["prepare", "stop", "backup", "switch", "start", "verify"])
        self.assertFalse((self.root / "active.json").exists())
        self.assertEqual(deploy.read_json(record / "status.json")["phase"], "complete")

    def test_repeated_healthy_deployments_are_serial_and_auditable(self):
        first = self.run_transaction(FakeDriver())
        second = self.run_transaction(FakeDriver())
        self.assertNotEqual(first, second)

    def test_each_failure_preserves_marker_and_never_rolls_back(self):
        for stage in ["prepare", "stop", "backup", "switch", "start", "verify"]:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                driver = FakeDriver(stage)
                root = Path(directory)
                with self.assertRaises(deploy.DeployError):
                    deploy.transact(IMAGE, root, driver)
                self.assertTrue((root / "active.json").exists())
                if stage in ["prepare", "stop", "backup"]:
                    self.assertNotIn("switch", driver.calls)
                self.assertNotIn("rollback", driver.calls)
                blocked = FakeDriver()
                with self.assertRaises(deploy.DeployError):
                    deploy.transact(IMAGE, root, blocked)
                self.assertEqual(blocked.calls, [])

    def test_overlapping_invocation_is_rejected(self):
        import fcntl
        with (self.root / "deploy.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(deploy.DeployError):
                self.run_transaction(FakeDriver())

    def test_interrupted_deployment_keeps_recovery_marker(self):
        driver = FakeDriver()
        with patch.object(driver, "start", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_transaction(driver)
        self.assertTrue((self.root / "active.json").exists())


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config_dir = self.root / "deployment"
        self.config_dir.mkdir()
        for name, value in {".env": "DSH_IMAGE=old\nSECRET=canary-private-value\n",
                            "compose.yaml": "existing compose", "web-admin-password.hash": "hash"}.items():
            (self.config_dir / name).write_text(value)
        self.volume_root = self.root / "volumes"
        self.volume = self.volume_root / deploy.VOLUME / "_data"
        self.volume.mkdir(parents=True)
        (self.volume / "history.jsonl").write_text('{"entry":"saved"}\n')
        self.enterContext(patch.object(deploy, "DEPLOY_DIR", self.config_dir))
        self.enterContext(patch.object(deploy, "VOLUME_ROOT", self.volume_root))
        self.enterContext(patch.object(deploy, "BACKUP_DIR", self.root))
        self.enterContext(patch.object(deploy.pwd, "getpwnam", return_value=type("User", (), {"pw_uid": os.getuid()})()))
        # Production ownership checks are covered separately; fixtures live under /tmp.
        def fixture_path(path, *args, **kwargs):
            if path.name == "web-admin-password.hash":
                return type("Stat", (), {"st_uid": 10001, "st_mode": stat.S_IFREG | 0o400})()
            return path.stat() if path.exists() else None
        (self.config_dir / ".env").chmod(0o600)
        self.enterContext(patch.object(deploy, "checked_path", side_effect=fixture_path))
        self.enterContext(patch.object(deploy.shutil, "disk_usage", return_value=type("Disk", (), {"free": 10 ** 12})()))
        self.driver = deploy.DockerDriver()
        self.calls = []
        self.running = True
        self.current_image = "old"
        self.current_id = "sha256:" + "b" * 64
        self.health = "healthy"
        self.candidate = {"Id": "sha256:" + "a" * 64, "Os": "linux", "Architecture": "amd64",
                          "Config": {"User": "dsh", "Labels": {
                              "org.opencontainers.image.revision": "c" * 40,
                              "org.opencontainers.image.source": "https://github.com/PABIPRG/pa-investment-research"}}}
        self.config = {"services": {"investment": {"image": "old", "read_only": True, "cap_drop": ["ALL"],
                          "networks": {"panel": {}}, "volumes": [{"type": "volume", "source": "dsh-data", "target": "/var/lib/dsh"}]}},
                       "networks": {"panel": {"name": "1panel-network"}},
                       "volumes": {"dsh-data": {"name": deploy.VOLUME}}}
        self.driver.run = self.fake_run

    def fake_run(self, args, timeout=120):
        self.calls.append(args)
        if args[:3] == ["docker", "compose", "--project-directory"]:
            command = args[len(self.driver.compose):]
            if command[:1] == ["config"]:
                return json.dumps(self.config)
            if command[:1] == ["ps"]:
                return "container-id"
            if command[:1] == ["stop"]:
                self.running = False
                return ""
            if command[:1] == ["up"]:
                self.running = True
                self.current_image = IMAGE
                self.current_id = self.candidate["Id"]
                return ""
        if args[:3] == ["docker", "container", "inspect"]:
            return json.dumps([{"Id": "container-id", "Image": self.current_id,
                                "Config": {"Image": self.current_image, "Env": ["SECRET=canary-private-value"]},
                                "State": {"Running": self.running, "Status": "running" if self.running else "exited",
                                          "ExitCode": 0, "Health": {"Status": self.health}},
                                "Mounts": [{"Destination": "/var/lib/dsh", "Name": deploy.VOLUME}]}])
        if args[:3] == ["docker", "volume", "inspect"]:
            return json.dumps([{"Driver": "local", "Options": None, "Mountpoint": str(self.volume)}])
        if args[:2] == ["docker", "ps"]:
            return "container-id" if self.running else ""
        if args[:2] == ["docker", "pull"]:
            return ""
        if args[:3] == ["docker", "image", "inspect"]:
            return json.dumps([self.candidate])
        if args[:1] == ["du"]:
            return "1024\t" + str(self.volume)
        if args[:2] == ["docker", "exec"]:
            return "ok"
        if args[:1] == ["curl"]:
            return '{"status":"ok"}'
        if args[:1] == ["tar"]:
            return subprocess.check_output(args, text=True)
        raise AssertionError("unexpected command " + str(args))

    def test_prepare_accepts_existing_network_alias_and_pulls_before_stop(self):
        result = self.driver.prepare(IMAGE, self.root)
        self.assertEqual(result["revision"], "c" * 40)
        self.assertIn(["docker", "pull", IMAGE], self.calls)
        self.assertTrue(self.running)

    def test_incorrect_architecture_and_root_image_fail_before_stop(self):
        for field, value in [("Architecture", "arm64"), ("Os", "windows")]:
            with self.subTest(field=field):
                original = self.candidate[field]
                self.candidate[field] = value
                with self.assertRaises(deploy.DeployError):
                    self.driver.prepare(IMAGE, self.root)
                self.candidate[field] = original
        self.candidate["Config"]["User"] = "root"
        with self.assertRaises(deploy.DeployError):
            self.driver.prepare(IMAGE, self.root)
        self.assertTrue(self.running)

    def test_another_volume_or_writable_runtime_is_rejected(self):
        self.config["volumes"]["dsh-data"]["name"] = "other-volume"
        with self.assertRaises(deploy.DeployError):
            self.driver.prepare(IMAGE, self.root)
        self.assertNotIn(["docker", "pull", IMAGE], self.calls)

    def test_insufficient_space_after_pull_does_not_stop_service(self):
        with patch.object(deploy.shutil, "disk_usage", side_effect=[
                type("Disk", (), {"free": 10 ** 12})(), type("Disk", (), {"free": 0})()]):
            with self.assertRaisesRegex(deploy.DeployError, "after image pull"):
                self.driver.prepare(IMAGE, self.root)
        self.assertTrue(self.running)

    def test_readable_environment_file_is_rejected(self):
        (self.config_dir / ".env").chmod(0o644)
        with self.assertRaisesRegex(deploy.DeployError, "private"):
            self.driver.prepare(IMAGE, self.root)

    def test_a_second_writer_blocks_backup(self):
        self.driver.prepare(IMAGE, self.root)
        with patch.object(self.driver, "volume_users", return_value=["other-writer"]):
            with self.assertRaisesRegex(deploy.DeployError, "writer"):
                self.driver.stop()

    def test_unhealthy_or_exited_candidate_fails_verification(self):
        self.driver.prepare(IMAGE, self.root)
        self.driver.switch(IMAGE)
        self.driver.start()
        self.health = "unhealthy"
        with self.assertRaisesRegex(deploy.DeployError, "unhealthy"):
            self.driver.verify(IMAGE)
        self.running = False
        with self.assertRaisesRegex(deploy.DeployError, "exited"):
            self.driver.verify(IMAGE)

    def test_switch_refuses_concurrent_configuration_edit(self):
        self.driver.prepare(IMAGE, self.root)
        (self.config_dir / ".env").write_text("DSH_IMAGE=operator-changed\n")
        with self.assertRaises(deploy.DeployError):
            self.driver.switch(IMAGE)
        self.assertEqual((self.config_dir / ".env").read_text(), "DSH_IMAGE=operator-changed\n")

    def test_failure_diagnostics_do_not_dump_environment(self):
        with patch.object(deploy.subprocess, "run"):
            self.driver.diagnose(self.root)
        self.assertNotIn("canary-private-value", (self.root / "diagnostics.json").read_text())

    def test_health_checks_image_identity_and_public_response(self):
        self.driver.prepare(IMAGE, self.root)
        self.driver.switch(IMAGE)
        self.driver.start()
        self.driver.verify(IMAGE)
        self.assertTrue(any(command[0] == "curl" for command in self.calls))
        self.current_id = "sha256:" + "d" * 64
        with self.assertRaises(deploy.DeployError):
            self.driver.verify(IMAGE)

    @unittest.skipUnless(sys.platform == "linux", "GNU tar restore rehearsal runs on Linux CI")
    def test_real_archive_restores_history_sqlite_and_hidden_files(self):
        import sqlite3
        import hashlib
        (self.volume / ".dsh-instance.json").write_text('{"version":1}')
        with sqlite3.connect(self.volume / "sessions.sqlite") as connection:
            connection.execute("CREATE TABLE history (message TEXT)")
            connection.execute("INSERT INTO history VALUES ('saved')")
        self.driver.prepare(IMAGE, self.root)
        self.driver.stop()
        record = self.root / "backup"
        record.mkdir()
        self.driver.backup(record)
        checksums = deploy.read_json(record / "backup-sha256.json")
        for name, digest in checksums.items():
            self.assertEqual(hashlib.sha256((record / name).read_bytes()).hexdigest(), digest)
        restored = self.root / "restored"
        restored.mkdir()
        subprocess.run(["tar", "-xzpf", str(record / "dsh-data.tar.gz"), "-C", str(restored)], check=True)
        self.assertEqual((restored / "history.jsonl").read_bytes(), (self.volume / "history.jsonl").read_bytes())
        self.assertTrue((restored / ".dsh-instance.json").exists())
        with sqlite3.connect(restored / "sessions.sqlite") as connection:
            self.assertEqual(connection.execute("SELECT message FROM history").fetchall(), [("saved",)])


class FileSafetyTests(unittest.TestCase):
    def test_atomic_write_preserves_mode_and_replaces_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("before")
            deploy.atomic_write(path, "after", 0o600)
            self.assertEqual(path.read_text(), "after")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_symlink_or_group_writable_ancestor_is_rejected(self):
        import stat
        for mode in [stat.S_IFLNK | 0o777, stat.S_IFDIR | 0o775]:
            with self.subTest(mode=mode), patch.object(Path, "lstat", return_value=type("Stat", (), {"st_mode": mode, "st_uid": 0})()):
                with self.assertRaises(deploy.DeployError):
                    deploy.checked_path(Path("/etc/pa-investment-deploy/docker"), {0})


if __name__ == "__main__":
    unittest.main()
