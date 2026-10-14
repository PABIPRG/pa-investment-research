"""Local-only retention regressions; Docker is always replaced by a fake."""
import contextlib
import io
import json
import copy
import datetime
import os
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import deploy
from test_deploy import FakeDriver, IMAGE


def image_id(n):
    return "sha256:" + format(n, "064x")


def success(n, image, phase="complete"):
    return {"phase": phase, "new_image_id": image_id(image),
            "completed_at": "2026-10-%02dT00:00:00+00:00" % n}


class HistoryTests(unittest.TestCase):
    def test_selects_distinct_successes_not_image_creation_or_failed_attempts(self):
        records = [("r1", success(1, 1)), ("r2", success(2, 2)), ("r3", success(3, 3)),
                   ("r4", success(4, 4, "recovery-required")), ("r5", success(5, 3)),
                   ("r6", success(6, 5))]
        self.assertEqual(deploy.retained_successes(records, image_id(5)),
                         {image_id(2), image_id(3), image_id(5)})

    def test_rollback_to_old_image_still_keeps_two_other_successful_versions(self):
        records = [("r1", success(1, 1)), ("r2", success(2, 2)), ("r3", success(3, 3))]
        self.assertEqual(deploy.retained_successes(records, image_id(1)),
                         {image_id(1), image_id(2), image_id(3)})

    def test_insufficient_history_blocks_deletion(self):
        with self.assertRaisesRegex(deploy.DeployError, "two successful historical"):
            deploy.retained_successes([("r1", success(1, 1))], image_id(1))

    def test_legacy_complete_uses_transaction_stamp_never_mtime(self):
        records = [("20260901T120000Z-aaaaaaaaaaaa", {"phase": "complete", "new_image_id": image_id(1)}),
                   ("20260902T120000Z-bbbbbbbbbbbb", {"phase": "complete", "new_image_id": image_id(2)}),
                   ("r3", success(3, 3))]
        self.assertEqual(deploy.retained_successes(records, image_id(3)),
                         {image_id(1), image_id(2), image_id(3)})
        records[0][1]["new_image_id"] = "short"
        with self.assertRaises(deploy.DeployError):
            deploy.retained_successes(records, image_id(3))


class CleanupTransactionTests(unittest.TestCase):
    def test_cleanup_runs_after_durable_success_inside_deploy_lock(self):
        class Driver(FakeDriver):
            def cleanup(self, state, record):
                self.step("cleanup")
                self_test.assertFalse((state / "active.json").exists())
                status = deploy.read_json(record / "status.json")
                self_test.assertEqual(status["phase"], "complete")
                self_test.assertIn("completed_at", status)
                with self_test.assertRaisesRegex(deploy.DeployError, "another deployment"):
                    deploy.transact(IMAGE, state, FakeDriver())
                return {"result": "ok"}

        self_test = self
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            driver = Driver()
            record = deploy.transact(IMAGE, Path(temp), driver)
            self.assertEqual(driver.calls[-2:], ["verify", "cleanup"])
            self.assertEqual(deploy.read_json(record / "cleanup.json")["result"], "ok")

    def test_cleanup_failure_or_interrupt_never_reclassifies_success(self):
        for error in (OSError("canary-private-value"), KeyboardInterrupt(), deploy.DeployError("bad")):
            with self.subTest(error=type(error)), tempfile.TemporaryDirectory() as temp:
                driver = FakeDriver()
                driver.cleanup = lambda *_: (_ for _ in ()).throw(error)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    record = deploy.transact(IMAGE, Path(temp), driver)
                self.assertEqual(deploy.read_json(record / "status.json")["phase"], "complete")
                self.assertFalse((Path(temp) / "active.json").exists())
                self.assertEqual(deploy.read_json(record / "cleanup.json")["result"], "failed")
                self.assertNotIn("canary-private-value", (record / "cleanup.json").read_text())

    def test_failed_health_never_enters_cleanup(self):
        driver = FakeDriver("verify")
        driver.cleanup = lambda *_: self.fail("cleanup after failed health")
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(deploy.DeployError):
                deploy.transact(IMAGE, Path(temp), driver)


class CandidateTests(unittest.TestCase):
    def test_root_objects_accept_admin_ancestors_but_reject_admin_owned_leaf(self):
        with patch.object(deploy.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=1000)), \
                patch.object(deploy, "checked_path", return_value=SimpleNamespace(st_uid=0)) as check:
            deploy.retention_path(Path("/home/admin/objects/hash"), {0})
            self.assertEqual(check.call_args.args[1], {0, 1000})
            check.return_value = SimpleNamespace(st_uid=1000)
            with self.assertRaises(deploy.DeployError):
                deploy.retention_path(Path("/home/admin/objects/hash"), {0})

    def test_only_project_owned_images_without_foreign_tags_are_candidates(self):
        item = {"Id": image_id(1), "Config": {"Labels": {"org.opencontainers.image.source":
                "https://github.com/PABIPRG/pa-investment-research"}}, "RepoTags": [], "RepoDigests": []}
        self.assertTrue(deploy.project_image(item))
        item["RepoTags"] = [deploy.REPOSITORY + ":v1", "other:keep"]
        self.assertFalse(deploy.project_image(item))
        item["RepoTags"] = [deploy.REPOSITORY + ":v1"]
        self.assertTrue(deploy.project_image(item))
        item["Config"]["Labels"] = {}
        self.assertFalse(deploy.project_image(item))


class RetentionDriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "state"
        self.config = self.root / "deployment"
        self.records = self.root / "backups"
        self.artifacts = self.root / "artifacts"
        self.report = self.root / "report"
        for path in (self.state, self.config, self.records, self.artifacts, self.report):
            path.mkdir()
        (self.config / ".env").write_text("DSH_IMAGE=" + deploy.REPOSITORY + ":v3\nSECRET=canary-private\n")
        (self.config / "compose.yaml").write_text("services: fixture\n")
        for n in (1, 2, 3):
            directory = self.records / str(n)
            directory.mkdir()
            deploy.write_json(directory / "status.json", success(n, n))
        self.images = {image_id(n): {"Id": image_id(n), "RepoTags": [deploy.REPOSITORY + ":v" + str(n)],
                       "RepoDigests": [], "Config": {"Labels": {"org.opencontainers.image.source": deploy.SOURCE_LABEL}}}
                       for n in range(1, 9)}
        self.containers = {"running": {"Id": "running", "Image": image_id(3),
                                      "State": {"Running": True, "Health": {"Status": "healthy"}}}}
        self.calls = []
        self.driver = deploy.DockerDriver("", "")
        self.driver.record_root = self.records
        self.driver.container = lambda: copy.deepcopy(self.containers["running"])
        self.driver.inspect = self.inspect
        self.driver.run = self.run_command
        self.enterContext(patch.object(deploy, "DEPLOY_DIR", self.config))
        self.enterContext(patch.object(deploy, "ARTIFACT_DIR", self.artifacts))
        self.enterContext(patch.object(deploy.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=os.getuid())))
        # Test ownership-independent behavior without root; retain link/type checks.
        self.enterContext(patch.object(deploy, "checked_path", side_effect=self.local_checked))
        self.enterContext(patch.object(deploy, "retention_path", side_effect=self.local_checked))

    def local_checked(self, path, owners, secret=False):
        for entry in (path, *path.parents):
            if entry == self.root.parent:
                break
            deploy.require(not entry.is_symlink(), "symlink")
        return path.stat()

    def inspect(self, ref, kind="container"):
        if kind == "container":
            return copy.deepcopy(self.containers[ref])
        for identifier, item in self.images.items():
            if ref == identifier or ref in item["RepoTags"] + item["RepoDigests"]:
                return copy.deepcopy(item)
        raise deploy.DeployError("image not present")

    def run_command(self, args, **kwargs):
        self.calls.append(args)
        if args[:3] == ["docker", "ps", "-aq"]:
            return " ".join(self.containers)
        if args[:3] == ["docker", "image", "ls"]:
            return " ".join(self.images)
        if args[:2] == ["docker", "compose"]:
            return json.dumps({"services": {"investment": {"image": deploy.REPOSITORY + ":v3"}}})
        if args[:3] == ["docker", "image", "rm"]:
            self.assertEqual(args[3], "--no-prune")
            identifier = self.inspect(args[-1], "image")["Id"]
            item = self.images[identifier]
            if args[-1] in item["RepoTags"]:
                item["RepoTags"].remove(args[-1])
            elif args[-1] in item["RepoDigests"]:
                item["RepoDigests"].remove(args[-1])
            if not item["RepoTags"] and not item["RepoDigests"] or args[-1] == identifier:
                del self.images[identifier]
            return "removed"
        self.fail("unexpected command: " + str(args))

    def policy(self, mode="apply", pins=None):
        deploy.write_json(self.state / "retention-policy.json", {
            "schema": 1, "mode": mode, "protected_images": pins or [], "config_roots": [],
        })

    def deleted(self):
        return [args for args in self.calls if args[:3] == ["docker", "image", "rm"]]

    def test_default_is_dry_run_and_never_leaks_configuration_values(self):
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["result"], "dry-run")
        self.assertEqual(self.deleted(), [])
        self.assertNotIn("canary", json.dumps(result))

    def test_apply_protects_success_history_pins_nested_env_stopped_users_and_foreign_aliases(self):
        self.policy(pins=[image_id(4)])
        nested = self.config / "observatory-config.fixture"
        nested.mkdir()
        (nested / ".env").write_text("DSH_IMAGE='" + deploy.REPOSITORY + ":v5'\n")
        self.containers["stopped"] = {"Image": image_id(6)}
        self.images[image_id(7)]["RepoTags"].append("foreign:keep")
        self.images[image_id(8)]["RepoTags"].append(deploy.REPOSITORY + ":old-version")
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["removed_images"], [image_id(8)])
        self.assertEqual(set(self.images), {image_id(n) for n in range(1, 8)})
        self.assertTrue(all("--force" not in args and "prune" not in args for args in self.calls))

    def test_unknown_config_or_unavailable_pin_fails_closed(self):
        self.policy(pins=[image_id(99)])
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])
        self.policy()
        (self.config / ".env").write_text("DSH_IMAGE=${UNKNOWN}\n")
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])

    def test_configuration_change_before_delete_stops_cleanup(self):
        self.policy()
        original = self.driver.retention_snapshot
        calls = 0
        def snapshot(state, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.config / ".env").write_text("DSH_IMAGE=" + deploy.REPOSITORY + ":v8\n")
            return original(state, **kwargs)
        self.driver.retention_snapshot = snapshot
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["result"], "partial")
        self.assertEqual(self.deleted(), [])

    def test_all_pending_states_corrupt_records_and_symlinks_prevent_cleanup(self):
        self.policy()
        for name in ("active.json", "deployer-update-pending.json"):
            marker = self.state / name
            marker.write_text("{}")
            with self.assertRaises(deploy.DeployError):
                self.driver.cleanup(self.state, self.report)
            marker.unlink()
        (self.records / "1" / "status.json").write_text("invalid")
        with self.assertRaises(ValueError):
            self.driver.cleanup(self.state, self.report)
        deploy.write_json(self.records / "1" / "status.json", success(1, 1))
        (self.config / "linked").symlink_to(self.records, target_is_directory=True)
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])

    def test_docker_failure_is_reported_and_remaining_candidates_are_kept(self):
        self.policy()
        original = self.driver.run
        def run(args, **kwargs):
            if args[:3] == ["docker", "image", "rm"]:
                raise deploy.CommandFailure("private", "exit", 1)
            return original(args, **kwargs)
        self.driver.run = run
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["result"], "partial")
        self.assertEqual(result["removed_images"], [])
        self.assertEqual(len(self.images), 8)
        self.assertNotIn("private", json.dumps(result))

    def test_new_container_reference_between_checks_prevents_delete(self):
        self.policy()
        original = self.driver.retention_snapshot
        count = 0
        def snapshot(state, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                self.containers["new-stopped-user"] = {"Image": image_id(4)}
            return original(state, **kwargs)
        self.driver.retention_snapshot = snapshot
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["result"], "partial")
        self.assertEqual(self.deleted(), [])

    def test_missing_history_and_unhealthy_current_never_delete(self):
        self.policy()
        self.containers["running"]["State"]["Health"]["Status"] = "unhealthy"
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.containers["running"]["State"]["Health"]["Status"] = "healthy"
        del self.images[image_id(1)]
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])

    def test_digest_only_and_dangling_project_images_are_removed_without_force(self):
        self.policy()
        self.images[image_id(4)]["RepoTags"] = []
        self.images[image_id(4)]["RepoDigests"] = [deploy.REPOSITORY + "@" + image_id(44)]
        self.images[image_id(5)]["RepoTags"] = []
        result = self.driver.cleanup(self.state, self.report)
        self.assertEqual(result["result"], "complete")
        self.assertIn(["docker", "image", "rm", "--no-prune", image_id(5)], self.deleted())
        self.assertIn(["docker", "image", "rm", "--no-prune", deploy.REPOSITORY + "@" + image_id(44)], self.deleted())

    def artifact(self, image, days=10):
        payload = ("fixture-" + str(image)).encode()
        import hashlib
        digest = hashlib.sha256(payload).hexdigest()
        directory = self.artifacts / digest
        directory.mkdir()
        (directory / "archive.tar.gz").write_bytes(payload)
        deploy.write_json(directory / "metadata.json", {
            "schema": 1, "sha256": digest, "image_id": image_id(image),
            "imported_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).isoformat(),
        })
        return directory

    def test_artifacts_share_protection_and_new_candidates_get_seven_day_grace(self):
        self.policy()
        current = self.artifact(3)
        historical = self.artifact(2)
        pending = self.artifact(8, 1)
        obsolete = self.artifact(7)
        result = self.driver.cleanup(self.state, self.report)
        self.assertFalse(obsolete.exists())
        self.assertTrue(all(path.exists() for path in (current, historical, pending)))
        self.assertIn(image_id(8), self.images)
        self.assertEqual(result["removed_artifacts"], [obsolete.name])

    def test_unknown_artifact_files_and_checksum_drift_prevent_any_deletion(self):
        self.policy()
        archive = self.artifact(7)
        (archive / "business-data.db").write_text("must survive")
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])
        (archive / "business-data.db").unlink()
        (archive / "archive.tar.gz").write_text("corrupt")
        with self.assertRaises(deploy.DeployError):
            self.driver.cleanup(self.state, self.report)
        self.assertEqual(self.deleted(), [])


if __name__ == "__main__":
    unittest.main()
