"""Exercise the privileged updater using isolated files and fake GitHub responses."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import update_deployer as updater
import install_deployer_updater as bootstrap


OLD_REVISION = "a" * 40
NEW_REVISION = "b" * 40
OLD_SOURCE = b'print("old reviewed deployer")\n'
NEW_SOURCE = b'print("new reviewed deployer")\n'


def digest(source):
    return hashlib.sha256(source).hexdigest()


def metadata(revision, source):
    return {"schema": 1, "revision": revision, "sha256": digest(source)}


class SourceTests(unittest.TestCase):
    def test_request_has_only_a_full_revision_and_digest(self):
        self.assertEqual(updater.read_request(io.StringIO(NEW_REVISION + "\n" + digest(NEW_SOURCE) + "\n")),
                         (NEW_REVISION, digest(NEW_SOURCE)))
        for value in ["", "master\n" + digest(NEW_SOURCE) + "\n",
                      NEW_REVISION + "\n" + "g" * 64 + "\n",
                      NEW_REVISION + "\n" + digest(NEW_SOURCE),
                      NEW_REVISION + "\n" + digest(NEW_SOURCE) + "\nextra\n", "x" * 4097]:
            with self.subTest(value=value[:50]), self.assertRaises(updater.UpdateError):
                updater.read_request(io.StringIO(value))

    def contents(self, source=NEW_SOURCE):
        blob = hashlib.sha1(b"blob " + str(len(source)).encode() + b"\0" + source).hexdigest()
        return {"type": "file", "path": updater.SOURCE_PATH, "size": len(source),
                "encoding": "base64", "content": base64.b64encode(source).decode(), "sha": blob}

    def test_only_the_fixed_repository_and_file_are_read(self):
        with patch.object(updater.GitHubSource, "api", return_value=self.contents()) as api:
            self.assertEqual(updater.GitHubSource().read(NEW_REVISION), NEW_SOURCE)
        api.assert_called_once_with("contents/ops/pa-investment/deploy.py?ref=" + NEW_REVISION)

    def test_invalid_file_identity_and_oversize_content_are_rejected(self):
        for key, value in [("type", "symlink"), ("path", "other.py"), ("size", 0),
                           ("size", updater.MAX_SOURCE_BYTES + 1), ("encoding", "none"),
                           ("content", "invalid!"), ("sha", "c" * 40)]:
            with self.subTest(key=key), patch.object(updater.GitHubSource, "api", return_value={**self.contents(), key: value}):
                with self.assertRaises(updater.UpdateError):
                    updater.GitHubSource().read(NEW_REVISION)

    def test_non_mainline_or_rollback_comparisons_are_rejected(self):
        for status in ["behind", "diverged", None]:
            with self.subTest(status=status), patch.object(updater.GitHubSource, "api", return_value={"status": status}):
                with self.assertRaises(updater.UpdateError):
                    updater.GitHubSource().require_ancestor(OLD_REVISION, NEW_REVISION)

    def test_ancestry_checks_the_exact_base_and_merge_base(self):
        comparison = {"status": "ahead", "base_commit": {"sha": OLD_REVISION},
                      "merge_base_commit": {"sha": OLD_REVISION}}
        with patch.object(updater.GitHubSource, "api", return_value=comparison) as api:
            updater.GitHubSource().require_ancestor(OLD_REVISION, NEW_REVISION)
        self.assertEqual(api.call_args.args[0], "compare/" + OLD_REVISION + "..." + NEW_REVISION + "?per_page=1&page=2")
        comparison["merge_base_commit"] = {"sha": "c" * 40}
        with patch.object(updater.GitHubSource, "api", return_value=comparison):
            with self.assertRaises(updater.UpdateError):
                updater.GitHubSource().require_ancestor(OLD_REVISION, NEW_REVISION)

    def test_https_redirects_are_not_followed(self):
        with self.assertRaises(updater.UpdateError):
            updater.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://other.example/source")


class FakeSource:
    def __init__(self):
        self.source = NEW_SOURCE
        self.comparisons = []
        self.reads = []
        self.rejected = None

    def require_ancestor(self, base, head):
        self.comparisons.append((base, head))
        if self.rejected == (base, head):
            raise updater.UpdateError("unapproved ancestry")

    def read(self, revision):
        self.reads.append(revision)
        return self.source


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "deploy.py"
        self.target.write_bytes(OLD_SOURCE)
        self.target.chmod(0o644)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.release = self.state / "deployer-release.json"
        self.release.write_text(json.dumps(metadata(OLD_REVISION, OLD_SOURCE)))
        self.release.chmod(0o600)
        self.source = FakeSource()
        # Production checks the entire absolute root-owned path. Tests use a user-owned temp dir.
        self.trust = patch.object(updater, "checked_path", side_effect=lambda p, **kw: Path(p).lstat())
        self.trust.start()
        self.addCleanup(self.trust.stop)
        self.subject = updater.Updater(self.target, self.state, self.source)

    def synchronize(self):
        return self.subject.synchronize(NEW_REVISION, digest(NEW_SOURCE))

    def assert_old(self):
        self.assertEqual(self.target.read_bytes(), OLD_SOURCE)
        self.assertEqual(json.loads(self.release.read_text()), metadata(OLD_REVISION, OLD_SOURCE))

    def test_verified_update_is_atomic_auditable_and_idempotent(self):
        result = self.synchronize()
        self.assertEqual(result["result"], "updated")
        self.assertEqual(self.target.read_bytes(), NEW_SOURCE)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o644)
        self.assertEqual(json.loads(self.release.read_text()), metadata(NEW_REVISION, NEW_SOURCE))
        self.assertIn((NEW_REVISION, "master"), self.source.comparisons)
        self.assertIn((OLD_REVISION, NEW_REVISION), self.source.comparisons)
        records = list((self.state / "deployer-updates").iterdir())
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0] / "deploy.py.before").read_bytes(), OLD_SOURCE)
        self.assertFalse((self.state / "deployer-update-pending.json").exists())
        self.assertEqual(self.synchronize()["result"], "unchanged")
        self.assertEqual(len(self.source.reads), 1)

    def test_uninitialized_installation_fails_without_changing_script(self):
        self.release.unlink()
        with self.assertRaisesRegex(updater.UpdateError, "install"):
            self.synchronize()
        self.assertEqual(self.target.read_bytes(), OLD_SOURCE)
        self.assertEqual(self.source.reads, [])

    def test_bootstrap_installs_reviewed_source_and_records_baseline(self):
        self.release.unlink()
        self.subject.synchronize(NEW_REVISION, digest(NEW_SOURCE), initialize=True)
        self.assertEqual(self.target.read_bytes(), NEW_SOURCE)
        self.assertEqual(json.loads(self.release.read_text()), metadata(NEW_REVISION, NEW_SOURCE))

    def test_same_script_at_new_revision_does_not_create_an_update(self):
        self.source.source = OLD_SOURCE
        self.assertEqual(self.subject.synchronize(NEW_REVISION, digest(OLD_SOURCE))["result"], "unchanged")
        self.assert_old()
        self.assertFalse((self.state / "deployer-updates").exists())

    def test_wrong_hash_invalid_syntax_or_untrusted_history_preserves_installation(self):
        for case in ["hash", "syntax", "mainline", "rollback"]:
            with self.subTest(case=case):
                self.source.source = NEW_SOURCE
                self.source.rejected = None
                expected = digest(NEW_SOURCE)
                if case == "hash":
                    expected = "0" * 64
                elif case == "syntax":
                    self.source.source = b"def invalid(:\n"
                    expected = digest(self.source.source)
                else:
                    self.source.rejected = ((NEW_REVISION, "master") if case == "mainline"
                                            else (OLD_REVISION, NEW_REVISION))
                with self.assertRaises(updater.UpdateError):
                    self.subject.synchronize(NEW_REVISION, expected)
                self.assert_old()

    def test_unrecorded_script_changes_are_not_overwritten(self):
        self.target.write_bytes(b"unexpected local change\n")
        with self.assertRaisesRegex(updater.UpdateError, "installed"):
            self.synchronize()
        self.assertEqual(self.target.read_bytes(), b"unexpected local change\n")

    def test_active_deployment_blocks_update_before_network(self):
        (self.state / "active.json").write_text("{}")
        with self.assertRaisesRegex(updater.UpdateError, "recovery"):
            self.synchronize()
        self.assertEqual(self.source.reads, [])
        self.assert_old()

    def test_shared_lock_blocks_concurrent_deployment_or_update(self):
        import fcntl
        with (self.state / "deploy.lock").open("a") as locked:
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(updater.UpdateError, "active"):
                self.synchronize()
        self.assert_old()

    def test_metadata_write_failure_restores_old_script_and_metadata(self):
        original = updater.atomic_write

        def fail_release(path, payload, mode=0o600):
            if path == self.release and NEW_REVISION.encode() in payload:
                raise OSError("simulated full disk")
            return original(path, payload, mode)

        with patch.object(updater, "atomic_write", side_effect=fail_release):
            with self.assertRaises(OSError):
                self.synchronize()
        self.assert_old()
        self.assertFalse((self.state / "deployer-update-pending.json").exists())

    def test_interrupt_after_replace_is_recovered_before_retry(self):
        original = updater.atomic_write

        def crash(path, payload, mode=0o600):
            if path == self.release:
                raise KeyboardInterrupt()
            return original(path, payload, mode)

        with patch.object(updater, "atomic_write", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.synchronize()
        self.assertEqual(self.target.read_bytes(), NEW_SOURCE)
        self.assertTrue((self.state / "deployer-update-pending.json").exists())
        # Reject the next download: recovery must still restore the known previous version.
        self.source.source = b"bad download"
        with self.assertRaises(updater.UpdateError):
            self.synchronize()
        self.assert_old()
        self.assertFalse((self.state / "deployer-update-pending.json").exists())

    def test_recovery_refuses_unexpected_script_bytes(self):
        original = updater.atomic_write

        def crash(path, payload, mode=0o600):
            if path == self.release:
                raise KeyboardInterrupt()
            return original(path, payload, mode)

        with patch.object(updater, "atomic_write", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.synchronize()
        self.target.write_bytes(b"unexpected administrator edit\n")
        with self.assertRaisesRegex(updater.UpdateError, "changed during recovery"):
            self.synchronize()
        self.assertEqual(self.target.read_bytes(), b"unexpected administrator edit\n")
        self.assertTrue((self.state / "deployer-update-pending.json").exists())

    def test_interrupt_after_metadata_commit_rolls_back_before_next_verification(self):
        original = updater.atomic_write

        def crash(path, payload, mode=0o600):
            if path.name == "result.json":
                raise KeyboardInterrupt()
            return original(path, payload, mode)

        with patch.object(updater, "atomic_write", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.synchronize()
        self.assertEqual(json.loads(self.release.read_text()), metadata(NEW_REVISION, NEW_SOURCE))
        self.source.rejected = (NEW_REVISION, "master")
        with self.assertRaises(updater.UpdateError):
            self.synchronize()
        self.assert_old()

    def test_failed_download_never_changes_installed_files(self):
        with patch.object(self.source, "read", side_effect=updater.UpdateError("GitHub unavailable")):
            with self.assertRaises(updater.UpdateError):
                self.synchronize()
        self.assert_old()
        self.assertFalse((self.state / "deployer-update-pending.json").exists())

    def test_installer_preserves_existing_entry_and_rolls_back_on_sudo_failure(self):
        sources = self.root / "reviewed"
        sources.mkdir()
        destinations = self.root / "installed"
        destinations.mkdir()
        existing_wrapper = destinations / "pa-investment-deploy"
        existing_wrapper.write_bytes(b"existing Python 3.11 wrapper\n")
        existing_sudoers = destinations / "pa-investment-deploy.sudoers"
        existing_sudoers.write_bytes(b"existing limited sudo rule\n")
        targets = {name: (destinations / name, mode) for name, (_, mode) in bootstrap.TARGETS.items()}
        for name in targets:
            (sources / name).write_bytes(("reviewed " + name + "\n").encode())
        (sources / "deploy.py").write_bytes(NEW_SOURCE)
        calls = []

        def fail_final_check(rule=None):
            calls.append(rule)
            if len(calls) == 3:
                raise OSError("sudo verification failed")

        with self.assertRaises(OSError):
            bootstrap.install(updater, self.subject, sources, NEW_REVISION, targets, fail_final_check)
        self.assert_old()
        self.assertTrue(all(not destination.exists() for destination, _ in targets.values()))
        result = bootstrap.install(updater, self.subject, sources, NEW_REVISION, targets, lambda rule=None: None)
        self.assertEqual(result["result"], "installed")
        self.assertEqual(self.target.read_bytes(), NEW_SOURCE)
        self.assertEqual(existing_wrapper.read_bytes(), b"existing Python 3.11 wrapper\n")
        self.assertEqual(existing_sudoers.read_bytes(), b"existing limited sudo rule\n")
        for name, (destination, mode) in targets.items():
            self.assertEqual(destination.read_bytes(), (sources / name).read_bytes())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), mode)

    def test_installer_cannot_bypass_an_active_deployment(self):
        sources = self.root / "reviewed"
        sources.mkdir()
        (sources / "deploy.py").write_bytes(NEW_SOURCE)
        (self.state / "active.json").write_text("{}")
        with self.assertRaisesRegex(updater.UpdateError, "recovery"):
            bootstrap.install(updater, self.subject, sources, NEW_REVISION, {}, lambda rule=None: None)
        self.assert_old()


class FileTrustTests(unittest.TestCase):
    def test_links_wrong_owners_and_writable_parents_are_rejected(self):
        for mode, owner in [(stat.S_IFLNK | 0o777, 0), (stat.S_IFDIR | 0o775, 0),
                            (stat.S_IFDIR | 0o755, 1000)]:
            with self.subTest(mode=mode, owner=owner), patch.object(Path, "lstat", return_value=type(
                    "Stat", (), {"st_mode": mode, "st_uid": owner})()):
                with self.assertRaises(updater.UpdateError):
                    updater.checked_path(Path("/var/lib/pa-investment-deploy"))

    def test_root_entry_does_not_accept_bootstrap_arguments_or_a_shell(self):
        root = Path(__file__).parent
        wrapper = (root / "pa-investment-update-deployer").read_text()
        rule = (root / "pa-investment-update-deployer.sudoers").read_text()
        self.assertIn('test "$#" -eq 0 || exit 64', wrapper)
        self.assertIn("/usr/bin/env -i", wrapper)
        self.assertIn("/usr/bin/python3.11 -I -B /usr/local/libexec/pa-investment/update_deployer.py", wrapper)
        self.assertIn('/usr/local/sbin/pa-investment-update-deployer ""', rule)
        with patch.object(updater.os, "geteuid", return_value=0), \
             patch.object(updater.sys, "argv", ["update_deployer.py", "--initialize"]):
            with self.assertRaisesRegex(updater.UpdateError, "arguments"):
                updater.main()


if __name__ == "__main__":
    unittest.main()
