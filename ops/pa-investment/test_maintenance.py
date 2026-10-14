"""Exercise the actual tar importer against temporary files; no Docker or network."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import maintenance


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.objects = self.root / "objects"
        self.incoming = self.root / "incoming"
        self.incoming.mkdir()
        self.source = self.incoming / "investment-container.tar.gz"
        self.enterContext(patch.object(maintenance.deploy.pwd, "getpwnam",
                                      return_value=SimpleNamespace(pw_uid=os.getuid())))
        self.enterContext(patch.object(maintenance.deploy, "retention_path", side_effect=self.checked))

    def checked(self, path, owners):
        for entry in (path, *path.parents):
            if entry == self.root.parent:
                break
            maintenance.deploy.require(not entry.is_symlink(), "symlink")
        return path.stat()

    def archive(self, label=None, extra=None):
        config = json.dumps({"os": "linux", "architecture": "amd64", "config": {"Labels": {
            "org.opencontainers.image.source": label or maintenance.deploy.SOURCE_LABEL}}}).encode()
        config_name = hashlib.sha256(config).hexdigest() + ".json"
        files = {config_name: config, "layer.tar": b"inert layer fixture", "manifest.json": json.dumps([
            {"Config": config_name, "Layers": ["layer.tar"], "RepoTags": ["pa-investment-research:test"]}
        ]).encode()}
        with tarfile.open(self.source, "w:gz") as archive:
            for name, payload in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            if extra is not None:
                archive.addfile(extra)
        return maintenance.deploy.sha256_file(self.source), "sha256:" + hashlib.sha256(config).hexdigest()

    def test_import_and_duplicate_migration_preserve_unrelated_files_and_backups(self):
        digest, identifier = self.archive()
        backup = self.incoming / "dsh-data.tar.gz"
        backup.write_text("business backup")
        first = maintenance.import_archive(self.source, digest, self.objects)
        second = maintenance.import_archive(self.source, digest, self.objects, remove_source=True)
        self.assertEqual(first["object"], second["object"])
        self.assertEqual(first["image_id"], identifier)
        self.assertFalse(self.source.exists())
        self.assertEqual(backup.read_text(), "business backup")
        self.assertTrue(self.incoming.is_dir())
        self.assertEqual(len(list(self.objects.iterdir())), 1)
        target = self.objects / digest
        self.assertEqual(maintenance.deploy.sha256_file(target / "archive.tar.gz"), digest)

    def test_checksum_failure_never_removes_original_or_leaves_partial(self):
        self.archive()
        with self.assertRaises(maintenance.deploy.DeployError):
            maintenance.import_archive(self.source, "0" * 64, self.objects, remove_source=True)
        self.assertTrue(self.source.exists())
        self.assertEqual(list(self.objects.iterdir()), [])

    def test_insufficient_space_and_backup_roots_are_rejected_before_copy(self):
        digest, _ = self.archive()
        with patch.object(maintenance.shutil, "disk_usage", return_value=SimpleNamespace(free=1)):
            with self.assertRaises(maintenance.deploy.DeployError):
                maintenance.import_archive(self.source, digest, self.objects, True)
        self.assertTrue(self.source.exists())
        self.assertEqual(list(self.objects.iterdir()), [])
        with patch.object(maintenance.deploy, "BACKUP_DIR", self.incoming / "controlled-deployments"):
            with self.assertRaises(maintenance.deploy.DeployError):
                maintenance.import_archive(self.source, digest, self.objects, True)
        self.assertTrue(self.source.exists())

    def test_reimport_refreshes_grace_without_duplicating_archive(self):
        digest, _ = self.archive()
        maintenance.import_archive(self.source, digest, self.objects)
        metadata_path = self.objects / digest / "metadata.json"
        metadata = maintenance.deploy.read_json(metadata_path)
        metadata["imported_at"] = "2020-01-01T00:00:00+00:00"
        maintenance.deploy.write_json(metadata_path, metadata)
        maintenance.import_archive(self.source, digest, self.objects)
        self.assertNotEqual(maintenance.deploy.read_json(metadata_path)["imported_at"], metadata["imported_at"])
        self.assertEqual(len(list(self.objects.iterdir())), 1)

    def test_foreign_image_traversal_and_links_are_rejected(self):
        digest, _ = self.archive(label="https://example.invalid/other")
        with self.assertRaises(maintenance.deploy.DeployError):
            maintenance.import_archive(self.source, digest, self.objects, True)
        for member in (tarfile.TarInfo("../escape"), tarfile.TarInfo("/absolute"), tarfile.TarInfo("link")):
            if member.name == "link":
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc/passwd"
            digest, _ = self.archive(extra=member)
            with self.assertRaises(maintenance.deploy.DeployError):
                maintenance.import_archive(self.source, digest, self.objects, True)
            self.assertTrue(self.source.exists())

    def test_business_backup_name_is_rejected_even_when_content_is_an_image(self):
        digest, _ = self.archive()
        backup = self.incoming / "dsh-data.tar.gz"
        self.source.rename(backup)
        with self.assertRaises(maintenance.deploy.DeployError):
            maintenance.import_archive(backup, digest, self.objects, True)
        self.assertTrue(backup.exists())

    def test_existing_object_corruption_or_symlink_never_removes_source(self):
        digest, _ = self.archive()
        maintenance.import_archive(self.source, digest, self.objects)
        target = self.objects / digest
        (target / "archive.tar.gz").write_text("broken")
        with self.assertRaises(maintenance.deploy.DeployError):
            maintenance.import_archive(self.source, digest, self.objects, True)
        self.assertTrue(self.source.exists())
        (target / "archive.tar.gz").unlink()
        (target / "archive.tar.gz").symlink_to(self.source)
        with self.assertRaises(maintenance.deploy.DeployError):
            maintenance.import_archive(self.source, digest, self.objects, True)

    def test_source_change_during_import_preserves_both_copies(self):
        digest, _ = self.archive()
        original = maintenance.archive_image
        def inspect(path):
            identifier = original(path)
            self.source.write_bytes(b"new upload")
            return identifier
        with patch.object(maintenance, "archive_image", side_effect=inspect):
            with self.assertRaises(maintenance.deploy.DeployError):
                maintenance.import_archive(self.source, digest, self.objects, True)
        self.assertEqual(self.source.read_bytes(), b"new upload")
        self.assertTrue((self.objects / digest / "archive.tar.gz").exists())

    def test_maintenance_and_deployment_locks_conflict_and_pending_recovery_blocks(self):
        with (self.root / "deploy.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(maintenance.deploy.DeployError):
                with maintenance.maintenance_lock(self.root):
                    self.fail("lock entered")
        for name in ("active.json", "deployer-update-pending.json"):
            marker = self.root / name
            marker.write_text("{}")
            with self.assertRaises(maintenance.deploy.DeployError):
                with maintenance.maintenance_lock(self.root):
                    self.fail("pending recovery ignored")
            marker.unlink()


if __name__ == "__main__":
    unittest.main()
