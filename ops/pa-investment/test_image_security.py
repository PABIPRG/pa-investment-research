"""Security gate regressions use inert Docker-save fixtures; no Docker daemon."""
import hashlib
import io
import json
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import image_security as gate


def tar_bytes(entries):
    import tarfile
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, value, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == 'link':
                info.type = tarfile.SYMTYPE
                info.linkname = value
                archive.addfile(info)
            else:
                data = value.encode()
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def fixture(root, layers=None, history=None):
    import tarfile
    layers = layers or [[('app/safe.txt', 'safe', 'file')]]
    blobs = [tar_bytes(entries) for entries in layers]
    diff_ids = ['sha256:' + hashlib.sha256(blob).hexdigest() for blob in blobs]
    revision = 'a' * 40
    config = json.dumps({'os': 'linux', 'architecture': 'amd64',
                         'config': {'Labels': {'org.opencontainers.image.revision': revision}},
                         'history': history or [], 'rootfs': {'type': 'layers', 'diff_ids': diff_ids}}).encode()
    image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
    manifest = [{'Config': 'config.json', 'RepoTags': ['pa-investment-research:' + revision],
                 'Layers': [f'{i}/layer.tar' for i in range(len(blobs))]}]
    path = root / 'image.tar.gz'
    with tarfile.open(path, 'w:gz') as archive:
        for name, data in [('manifest.json', json.dumps(manifest).encode()), ('config.json', config),
                           *[(f'{i}/layer.tar', blob) for i, blob in enumerate(blobs)]]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return path, image_id, revision, diff_ids


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def prepare(self, **kwargs):
        archive, image, revision, _ = fixture(self.root, **kwargs)
        work = self.root / 'work'
        work.mkdir()
        return gate.prepare_archive(archive, work, image, revision)

    def test_deleted_old_secret_and_duplicate_entries_survive_scan_input(self):
        evidence = self.prepare(layers=[[('app/config', 'OLD_SECRET_CANARY', 'file'),
                                        ('app/config', 'replacement', 'file')],
                                       [('app/.wh.config', '', 'file')]])
        contents = [p.read_bytes() for p in evidence['scan_root'].rglob('*') if p.is_file()]
        self.assertTrue(any(b'OLD_SECRET_CANARY' in value for value in contents))
        self.assertEqual(evidence['layers'], 2)

    def test_metadata_and_link_targets_are_scanned_without_following_links(self):
        evidence = self.prepare(layers=[[('app/link', '/etc/SECRET_LINK_CANARY', 'link')]],
                                history=[{'created_by': 'SECRET_HISTORY_CANARY'}])
        files = list(evidence['scan_root'].rglob('*'))
        self.assertFalse(any(p.is_symlink() for p in files))
        data = b''.join(p.read_bytes() for p in files if p.is_file())
        self.assertIn(b'SECRET_HISTORY_CANARY', data)
        self.assertIn(b'SECRET_LINK_CANARY', data)

    def test_traversal_blocks_without_disclosing_path(self):
        with self.assertRaises(gate.GateError) as result:
            self.prepare(layers=[[('../SECRET_PATH_CANARY', 'value', 'file')]])
        self.assertNotIn('SECRET_PATH_CANARY', str(result.exception))

    def test_identity_mismatch_blocks(self):
        archive, _, revision, _ = fixture(self.root)
        with self.assertRaises(gate.GateError):
            gate.prepare_archive(archive, self.root / 'work', 'sha256:' + '0' * 64, revision)

    def test_sensitive_path_blocks_even_without_a_secret_pattern(self):
        evidence = self.prepare(layers=[[('app/.env.production', 'opaque', 'file')]])
        self.assertEqual(evidence['sensitive_paths'], 1)

    def test_cli_rejects_unsafe_archive_without_disclosing_image_content(self):
        archive, image, revision, _ = fixture(self.root, layers=[[('../SECRET_CLI_CANARY', 'payload', 'file')]])
        identity = self.root / 'image-id'
        identity.write_text(image)
        result = subprocess.run([sys.executable, '-B', str(Path(gate.__file__)), 'scan',
                                 '--archive', str(archive), '--image-id-file', str(identity),
                                 '--revision', revision, '--tools', str(self.root),
                                 '--work-parent', str(self.root), '--summary', str(self.root / 'summary.json')],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(b'SECRET_CLI_CANARY', result.stdout + result.stderr)
        self.assertNotIn(b'Traceback', result.stdout + result.stderr)

    def test_resource_limit_blocks_instead_of_skipping(self):
        with patch.object(gate, 'MAX_TOTAL_BYTES', 1), self.assertRaises(gate.GateError):
            self.prepare()


class ReportTests(unittest.TestCase):
    def test_no_report_and_malformed_reports_block(self):
        for report in [None, {}, {'Results': []}]:
            with self.subTest(report=report), self.assertRaises(gate.GateError):
                gate.vulnerability_counts(report, 'sha256:' + 'a' * 64, ['sha256:' + 'b' * 64])

    def test_report_identity_and_unfixed_high_vulnerabilities(self):
        image = 'sha256:' + 'a' * 64
        layers = ['sha256:' + 'b' * 64]
        report = {'SchemaVersion': 2, 'ArtifactType': 'container_image',
                  'Metadata': {'ImageID': image, 'DiffIDs': layers, 'OS': {'Family': 'debian'}},
                  'Results': [{'Class': 'lang-pkgs', 'Type': kind, 'Packages': [{'Name': 'example'}]}
                              for kind in ('node-pkg', 'python-pkg')] +
                             [{'Class': 'os-pkgs', 'Type': 'debian', 'Packages': [{'Name': 'example'}],
                               'Vulnerabilities': [{'VulnerabilityID': 'CVE-2099-1234',
                                                    'Severity': 'HIGH', 'FixedVersion': ''}]}]}
        self.assertEqual(gate.vulnerability_counts(report, image, layers)['HIGH'], 1)
        with self.assertRaises(gate.GateError):
            gate.vulnerability_counts(report, 'sha256:' + 'c' * 64, layers)

    def test_scanner_error_and_timeout_do_not_echo_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for behavior in [subprocess.CompletedProcess([], 2, b'SECRET_STDOUT', b'SECRET_STDERR'),
                             subprocess.TimeoutExpired('scanner', 1, output=b'SECRET_TIMEOUT')]:
                with self.subTest(behavior=type(behavior).__name__):
                    if isinstance(behavior, Exception):
                        mock = patch.object(gate.subprocess, 'run', side_effect=behavior)
                    else:
                        mock = patch.object(gate.subprocess, 'run', return_value=behavior)
                    with mock, self.assertRaises(gate.GateError) as error:
                        gate.run_scanner(['scanner'], root, timeout=1)
                    self.assertNotIn('SECRET_', str(error.exception))

    def test_scanner_warning_is_incomplete_scan(self):
        result = subprocess.CompletedProcess([], 0, b'', b'WARN archive could not be opened SECRET_CANARY')
        with tempfile.TemporaryDirectory() as directory, patch.object(gate.subprocess, 'run', return_value=result):
            with self.assertRaises(gate.GateError):
                gate.run_scanner(['scanner'], Path(directory), timeout=1)


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive, self.image, self.revision, self.layers = fixture(self.root)
        self.summary = self.root / 'summary.json'
        self.mode = 'clean'

    def scanner(self, command, cwd, **kwargs):
        from datetime import datetime, timezone
        tool = Path(command[0]).name
        if command[1] in ('version', '--version'):
            return subprocess.CompletedProcess(command, 0, b'8.30.1' if tool == 'gitleaks' else b'Version: 0.74.0', b'')
        if tool == 'gitleaks':
            if self.mode == 'no-secret-report':
                return subprocess.CompletedProcess(command, 0, b'', b'')
            report = Path(command[command.index('--report-path') + 1])
            report.write_text(json.dumps([{'Secret': 'SECRET_REPORT_CANARY'}] if self.mode == 'secret' else []))
        else:
            report = Path(command[command.index('--output') + 1])
            if self.mode != 'no-vuln-report':
                report.write_text(json.dumps({'SchemaVersion': 2, 'Trivy': {'Version': '0.74.0'},
                    'ArtifactType': 'container_image',
                    'Metadata': {'ImageID': self.image if self.mode != 'identity' else 'wrong',
                                 'DiffIDs': self.layers, 'OS': {'Family': 'debian'}},
                    'Results': [{'Class': 'lang-pkgs', 'Type': kind, 'Packages': [{'Name': 'example'}]}
                                for kind in ('node-pkg', 'python-pkg')] +
                               [{'Class': 'os-pkgs', 'Type': 'debian', 'Packages': [{'Name': 'example'}],
                                 'Vulnerabilities': [{'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'}]
                                 if self.mode == 'unfixed' else []}]}))
            cache = Path(command[command.index('--cache-dir') + 1]) / 'db'
            cache.mkdir(parents=True)
            (cache / 'metadata.json').write_text(json.dumps({'UpdatedAt': datetime.now(timezone.utc).isoformat()}))
        return subprocess.CompletedProcess(command, 10 if tool == 'gitleaks' and self.mode == 'secret' else 0, b'', b'')

    def invoke(self):
        with patch.object(gate.subprocess, 'run', side_effect=self.scanner):
            return gate.scan(self.archive, self.image, self.revision, self.root, self.root, self.summary)

    def test_success_is_bound_to_archive_and_publish_rejects_changed_archive(self):
        self.assertTrue(self.invoke()['passed'])
        gate.verify_summary(self.summary, self.archive, self.image, self.revision)
        with self.archive.open('ab') as stream:
            stream.write(b'changed')
        with self.assertRaises(gate.GateError):
            gate.verify_summary(self.summary, self.archive, self.image, self.revision)

    def test_missing_reports_mismatch_secrets_and_unfixed_vulnerabilities_block(self):
        for mode in ('no-secret-report', 'no-vuln-report', 'identity', 'secret', 'unfixed'):
            self.mode = mode
            with self.subTest(mode=mode), self.assertRaises(gate.GateError):
                self.invoke()
            if self.summary.exists():
                self.assertFalse(json.loads(self.summary.read_text())['passed'])
                self.assertNotIn('SECRET_REPORT_CANARY', self.summary.read_text())
            self.assertFalse(any(p.name.startswith('image-security-') for p in self.root.iterdir()))

    def test_byte_signature_controls_nested_archive_detection(self):
        self.assertEqual(gate.archive_suffix(b'plain dpkg metadata'), '.data')
        self.assertEqual(gate.archive_suffix(b'\x1f\x8b' + b'opaque'), '.gz')

    def test_scanner_download_checksum_mismatch_never_installs_binary(self):
        with patch.object(gate.urllib.request, 'urlopen', return_value=io.BytesIO(b'not official')):
            with self.assertRaisesRegex(gate.GateError, 'scanner-checksum-mismatch'):
                gate.install_scanners(self.root / 'tools')
        self.assertFalse((self.root / 'tools/gitleaks').exists())


if __name__ == '__main__':
    unittest.main()
