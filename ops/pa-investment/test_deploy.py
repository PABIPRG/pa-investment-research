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
REGISTRY_USERNAME = "jiahim"
REGISTRY_TOKEN = "ghs_" + "b" * 36


class InputTests(unittest.TestCase):
    def test_exact_private_registry_request(self):
        self.assertEqual(
            deploy.read_request(io.StringIO(
                IMAGE + "\n" + REGISTRY_USERNAME + "\n" + REGISTRY_TOKEN + "\n")),
            (IMAGE, REGISTRY_USERNAME, REGISTRY_TOKEN),
        )

    def test_rejects_invalid_or_incomplete_private_registry_request(self):
        valid = IMAGE + "\n" + REGISTRY_USERNAME + "\n" + REGISTRY_TOKEN + "\n"
        values = [
            IMAGE + "\n",
            valid + "extra\n",
            IMAGE.replace("pabiprg", "other") + "\n" + REGISTRY_USERNAME + "\n" + REGISTRY_TOKEN + "\n",
            IMAGE.replace("a" * 64, "A" * 64) + "\n" + REGISTRY_USERNAME + "\n" + REGISTRY_TOKEN + "\n",
            "ghcr.io/pabiprg/pa-investment-research:latest\n" + REGISTRY_USERNAME + "\n" + REGISTRY_TOKEN + "\n",
            IMAGE + "\ninvalid user\n" + REGISTRY_TOKEN + "\n",
            IMAGE + "\n" + REGISTRY_USERNAME + "\nshort\n",
            IMAGE + "\n" + REGISTRY_USERNAME + "\ncontains space\n",
            "x" * 4097,
            "",
        ]
        for value in values:
            with self.subTest(value=value[:80]), self.assertRaises(deploy.DeployError) as error:
                deploy.read_request(io.StringIO(value))
            self.assertNotIn(REGISTRY_TOKEN, str(error.exception))

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

    def test_verified_pull_failure_is_archived_without_blocking_next_deploy(self):
        class FailedPull(FakeDriver):
            def prepare(self, image, record):
                self.calls.append("prepare")
                raise deploy.PullFailure("docker pull failed after 2 attempts")

            def verify_unchanged_after_failed_pull(self):
                self.calls.append("verify-unchanged")
                return {"old_image": "old", "container_id": "old-id", "health": "healthy",
                        "public_health": "ok"}

        driver = FailedPull()
        with self.assertRaises(deploy.PullFailure):
            self.run_transaction(driver)
        self.assertEqual(driver.calls, ["prepare", "diagnose", "verify-unchanged"])
        self.assertFalse((self.root / "active.json").exists())
        record = next(path for path in self.root.iterdir() if path.is_dir())
        self.assertEqual(deploy.read_json(record / "status.json")["phase"], "prepare-failed-safe")
        self.assertEqual(deploy.read_json(record / "prepare-failure-disposition.json")["evidence"]["health"],
                         "healthy")
        self.run_transaction(FakeDriver())

    def test_pull_failure_keeps_marker_if_reverification_or_diagnostics_fail(self):
        class UnverifiedPull(FakeDriver):
            def prepare(self, image, record):
                raise deploy.PullFailure("docker pull failed after 2 attempts")

            def verify_unchanged_after_failed_pull(self):
                raise deploy.DeployError("old service changed")

        for diagnostic_failure in (False, True):
            with self.subTest(diagnostic_failure=diagnostic_failure), tempfile.TemporaryDirectory() as directory:
                driver = UnverifiedPull()
                if diagnostic_failure:
                    driver.diagnose = lambda record: (_ for _ in ()).throw(OSError("diagnostics unavailable"))
                with self.assertRaises(deploy.PullFailure):
                    deploy.transact(IMAGE, Path(directory), driver)
                self.assertEqual(deploy.read_json(Path(directory) / "active.json")["phase"],
                                 "recovery-required")

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
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.enterContext(patch.object(deploy, "STATE_DIR", self.state_dir))
        self.registry_runtime_dir = self.root / "runtime"
        self.registry_runtime_dir.mkdir()
        self.enterContext(patch.object(deploy, "REGISTRY_RUNTIME_DIR", self.registry_runtime_dir))
        self.enterContext(patch.object(deploy.pwd, "getpwnam", return_value=type("User", (), {"pw_uid": os.getuid()})()))
        # Production ownership checks are covered separately; fixtures live under /tmp.
        def fixture_path(path, *args, **kwargs):
            if path.name == "web-admin-password.hash":
                return type("Stat", (), {"st_uid": 10001, "st_mode": stat.S_IFREG | 0o400})()
            return path.stat() if path.exists() else None
        (self.config_dir / ".env").chmod(0o600)
        self.enterContext(patch.object(deploy, "checked_path", side_effect=fixture_path))
        self.enterContext(patch.object(deploy.shutil, "disk_usage", return_value=type("Disk", (), {"free": 10 ** 12})()))
        self.driver = deploy.DockerDriver(REGISTRY_USERNAME, REGISTRY_TOKEN)
        self.calls = []
        self.run_metadata = []
        self.running = True
        self.current_image = "old"
        self.current_id = "sha256:" + "b" * 64
        self.health = "healthy"
        self.candidate = {"Id": "sha256:" + "a" * 64, "Os": "linux", "Architecture": "amd64",
                          "Config": {"User": "10001:10001", "Labels": {
                              "org.opencontainers.image.revision": "c" * 40,
                              "org.opencontainers.image.source": "https://github.com/PABIPRG/pa-investment-research"}}}
        self.config = {"services": {"investment": {"image": "old", "read_only": True, "cap_drop": ["ALL"],
                          "networks": {"panel": {}},
                          "healthcheck": {"test": ["CMD", "/nodejs/bin/node", "/opt/container/investment-healthcheck.mjs"]},
                          "volumes": [{"type": "volume", "source": "dsh-data", "target": "/var/lib/dsh"}]}},
                       "networks": {"panel": {"name": "1panel-network"}},
                       "volumes": {"dsh-data": {"name": deploy.VOLUME}}}
        self.driver.run = self.fake_run

    def fake_run(self, args, timeout=120, input_text=None, environment=None):
        self.calls.append(args)
        self.run_metadata.append((args, input_text, environment))
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
        if args[:2] == ["docker", "login"]:
            return ""
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
        login = next(item for item in self.run_metadata if item[0][:2] == ["docker", "login"])
        pull = next(item for item in self.run_metadata if item[0][:2] == ["docker", "pull"])
        self.assertEqual(login[1], REGISTRY_TOKEN + "\n")
        self.assertNotIn(REGISTRY_TOKEN, login[0])
        self.assertEqual(login[2]["DOCKER_CONFIG"], pull[2]["DOCKER_CONFIG"])
        self.assertFalse(Path(login[2]["DOCKER_CONFIG"]).exists())
        self.assertLess(self.calls.index(login[0]), self.calls.index(pull[0]))
        self.assertTrue(self.running)

    def test_registry_login_failure_does_not_stop_service(self):
        docker_config = None
        login_attempts = 0

        def reject_login(args, **kwargs):
            nonlocal docker_config, login_attempts
            if args[:2] == ["docker", "login"]:
                login_attempts += 1
                docker_config = kwargs["environment"]["DOCKER_CONFIG"]
                raise deploy.DeployError("command failed: docker login")
            return self.fake_run(args, **kwargs)

        self.driver.run = reject_login
        with self.assertRaisesRegex(deploy.DeployError, "docker login"):
            self.driver.prepare(IMAGE, self.root)
        self.assertEqual(login_attempts, 1)
        self.assertIsNone(self.driver.registry_token)
        self.assertIsNotNone(docker_config)
        self.assertFalse(Path(docker_config).exists())
        self.assertTrue(self.running)

    def test_registry_pull_failure_removes_credentials_before_stop(self):
        docker_config = None
        pull_attempts = 0

        def reject_pull(args, **kwargs):
            nonlocal docker_config, pull_attempts
            if args[:2] == ["docker", "pull"]:
                pull_attempts += 1
                docker_config = kwargs["environment"]["DOCKER_CONFIG"]
                raise deploy.CommandFailure("command exit 1: docker pull", "exit", 1)
            return self.fake_run(args, **kwargs)

        self.driver.run = reject_pull
        with patch.object(deploy.time, "sleep") as pause:
            with self.assertRaisesRegex(deploy.PullFailure, "2 attempts"):
                self.driver.prepare(IMAGE, self.root)
        self.assertEqual(pull_attempts, 2)
        pause.assert_called_once()
        attempts = deploy.read_json(self.root / "image-pull.json")["attempts"]
        self.assertEqual([item["result"] for item in attempts], ["exit", "exit"])
        self.assertNotIn(REGISTRY_TOKEN, (self.root / "image-pull.json").read_text())
        self.assertIsNone(self.driver.registry_token)
        self.assertIsNotNone(docker_config)
        self.assertFalse(Path(docker_config).exists())
        self.assertTrue(self.running)

    def test_registry_pull_retries_once_and_succeeds_before_stop(self):
        attempts = 0

        def interrupted_once(args, **kwargs):
            nonlocal attempts
            if args[:2] == ["docker", "pull"]:
                attempts += 1
                if attempts == 1:
                    self.fake_run(args, **kwargs)
                    raise deploy.CommandFailure("command timed out: docker pull", "timeout")
            return self.fake_run(args, **kwargs)

        self.driver.run = interrupted_once
        with patch.object(deploy.time, "sleep") as pause:
            self.driver.prepare(IMAGE, self.root)
        self.assertEqual(attempts, 2)
        pause.assert_called_once()
        self.assertEqual([item["result"] for item in deploy.read_json(self.root / "image-pull.json")["attempts"]],
                         ["timeout", "success"])
        self.assertTrue(self.running)
        self.assertFalse(list(self.registry_runtime_dir.iterdir()))

    def test_failed_pull_reverification_requires_identical_healthy_old_service(self):
        self.driver.prepare(IMAGE, self.root)
        evidence = self.driver.verify_unchanged_after_failed_pull()
        self.assertEqual(evidence["health"], "healthy")
        (self.config_dir / ".env").write_text("DSH_IMAGE=changed\n")
        with self.assertRaises(deploy.DeployError):
            self.driver.verify_unchanged_after_failed_pull()
        (self.config_dir / ".env").write_text("DSH_IMAGE=old\nSECRET=canary-private-value\n")
        self.current_id = "sha256:" + "d" * 64
        with self.assertRaisesRegex(deploy.DeployError, "identity changed"):
            self.driver.verify_unchanged_after_failed_pull()
        self.current_id = "sha256:" + "b" * 64
        self.health = "unhealthy"
        with self.assertRaisesRegex(deploy.DeployError, "not running and healthy"):
            self.driver.verify_unchanged_after_failed_pull()
        self.health = "healthy"
        with patch.object(self.driver, "volume_users", return_value=["another-writer"]):
            with self.assertRaisesRegex(deploy.DeployError, "writers changed"):
                self.driver.verify_unchanged_after_failed_pull()
        with patch.object(deploy.shutil, "disk_usage", return_value=type("Disk", (), {"free": 0})()):
            with self.assertRaisesRegex(deploy.DeployError, "backup space"):
                self.driver.verify_unchanged_after_failed_pull()
        self.config["services"]["investment"]["image"] = "other"
        with self.assertRaisesRegex(deploy.DeployError, "Compose configuration changed"):
            self.driver.verify_unchanged_after_failed_pull()


    def test_prepare_accepts_user_declared_by_dockerfile(self):
        dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile"
        users = [line.split()[1] for line in dockerfile.read_text().splitlines()
                 if line.startswith("USER ")]
        self.assertEqual(users[-1], "10001:10001")
        self.candidate["Config"]["User"] = users[-1]
        self.driver.prepare(IMAGE, self.root)
        self.assertTrue(self.running)

    def test_incorrect_architecture_fails_before_stop(self):
        for field, value in [("Architecture", "arm64"), ("Os", "windows")]:
            with self.subTest(field=field):
                self.driver = deploy.DockerDriver(REGISTRY_USERNAME, REGISTRY_TOKEN)
                self.driver.run = self.fake_run
                original = self.candidate[field]
                self.candidate[field] = value
                with self.assertRaisesRegex(deploy.DeployError, "candidate must be linux/amd64"):
                    self.driver.prepare(IMAGE, self.root)
                self.candidate[field] = original
                self.assertTrue(self.running)

    def test_unapproved_users_fail_before_stop(self):
        for user in ["root", "0", "0:0", "10001:0", "10002:10002", "", "dsh", "10001"]:
            with self.subTest(user=user):
                self.driver = deploy.DockerDriver(REGISTRY_USERNAME, REGISTRY_TOKEN)
                self.driver.run = self.fake_run
                self.candidate["Config"]["User"] = user
                with self.assertRaisesRegex(deploy.DeployError, "candidate must run as 10001:10001"):
                    self.driver.prepare(IMAGE, self.root)
                self.assertTrue(self.running)
                self.assertIsNone(self.driver.registry_token)

    def test_incompatible_healthchecks_fail_before_pull_or_stop(self):
        for healthcheck in [
                {},
                {"test": ["CMD", "node", "/opt/container/investment-healthcheck.mjs"]},
                {"test": ["CMD-SHELL", "/nodejs/bin/node /opt/container/investment-healthcheck.mjs"]},
                {"test": ["NONE"]},
                {"test": ["CMD", "/nodejs/bin/node", "/opt/container/investment-healthcheck.mjs"],
                 "disable": True}]:
            with self.subTest(healthcheck=healthcheck):
                self.driver = deploy.DockerDriver(REGISTRY_USERNAME, REGISTRY_TOKEN)
                self.driver.run = self.fake_run
                self.calls.clear()
                self.config["services"]["investment"]["healthcheck"] = healthcheck
                with self.assertRaisesRegex(deploy.DeployError, "incompatible Compose healthcheck"):
                    self.driver.prepare(IMAGE, self.root)
                self.assertNotIn(["docker", "pull", IMAGE], self.calls)
                self.assertEqual(self.driver.registry_token, REGISTRY_TOKEN)
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
        self.assertIn(["docker", "exec", "container-id", "/nodejs/bin/node",
                       "/opt/container/investment-healthcheck.mjs"], self.calls)
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


class CommandFailureTests(unittest.TestCase):
    def test_timeout_and_nonzero_exit_have_safe_distinct_reasons(self):
        driver = deploy.DockerDriver(REGISTRY_USERNAME, REGISTRY_TOKEN)
        command = ["docker", "pull", IMAGE]
        failures = [
            (subprocess.TimeoutExpired(command, 900, stderr=REGISTRY_TOKEN), "timed out"),
            (subprocess.CalledProcessError(17, command, stderr=REGISTRY_TOKEN), "exit 17"),
        ]
        for failure, expected in failures:
            with self.subTest(expected=expected), patch.object(deploy.subprocess, "run", side_effect=failure):
                with self.assertRaisesRegex(deploy.DeployError, expected) as caught:
                    driver.run(command, timeout=900)
                self.assertNotIn(REGISTRY_TOKEN, str(caught.exception))


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
                    deploy.checked_path(Path("/run/pa-investment-deploy"), {0})


if __name__ == "__main__":
    unittest.main()
