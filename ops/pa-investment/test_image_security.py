"""Security gate regressions use inert Docker-save fixtures; no Docker daemon."""
import hashlib
import io
import json
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
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
                data = value.encode() if isinstance(value, str) else value
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


def vulnerability_exception(version='2.41-12+deb13u4'):
    return {'kind': 'trivy-vulnerability', 'id': 'CVE-2026-97399',
            'sourceClass': 'os-pkgs', 'sourceType': 'debian', 'package': 'libc6',
            'installedVersion': version, 'severity': 'UNKNOWN', 'platform': 'linux/amd64',
            'count': 1, 'reason': 'unaffected-platform', 'advisory': gate.CVE_97399_ADVISORY,
            'reviewedBy': 'test-reviewer', 'expiresAt': '2099-01-01T00:00:00Z'}


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

    def test_diagnostic_locations_preserve_duplicate_and_old_layer_identity(self):
        path = 'opt/investment-python/site-packages/example/SECRET_PATH_CANARY.py'
        evidence = self.prepare(layers=[[(path, 'old', 'file'), (path, 'new', 'file')],
                                       [(path, 'newer', 'file')]])
        findings = [{'RuleID': 'generic-api-key', 'File': str(evidence['scan_root'] / location),
                     'StartLine': 7, 'Secret': 'SECRET_VALUE_CANARY'}
                    for location in ('layer-0/file-0.data', 'layer-0/file-1.data', 'layer-1/file-0.data')]
        diagnostic = gate.secret_diagnostics(findings, evidence)
        samples = diagnostic['secretSamples']
        self.assertEqual([(s['location']['layer'], s['location']['entry']) for s in samples],
                         [(0, 0), (0, 1), (1, 0)])
        self.assertEqual({s['location']['pathSha256'] for s in samples},
                         {hashlib.sha256(path.encode()).hexdigest()})
        self.assertEqual({s['location']['class'] for s in samples}, {'python-dependency'})
        self.assertEqual([s['location']['fileSha256'] for s in samples],
                         [hashlib.sha256(value).hexdigest() for value in (b'old', b'new', b'newer')])
        self.assertNotIn('CANARY', json.dumps(diagnostic))

    def test_diagnostic_output_is_bounded_and_does_not_echo_report_fields(self):
        count = 107
        evidence = self.prepare(layers=[[(f'app/SECRET_PATH_CANARY-{i}/.env', 'opaque', 'file')
                                        for i in range(count)]])
        finding = {'RuleID': 'SECRET_RULE_CANARY', 'File': 'layer-0/file-0.data!SECRET_NESTED_CANARY',
                   'StartLine': 3, 'Secret': 'SECRET_VALUE_CANARY', 'Match': 'SECRET_MATCH_CANARY',
                   'Description': 'SECRET_DESCRIPTION_CANARY', 'Fingerprint': 'SECRET_FINGERPRINT_CANARY',
                   'Author': 'SECRET_AUTHOR_CANARY', 'Email': 'SECRET_EMAIL_CANARY'}
        diagnostic = gate.secret_diagnostics([finding] * count, evidence)
        self.assertEqual(diagnostic['secretFindings'], count)
        self.assertEqual(diagnostic['sensitivePaths'], count)
        self.assertEqual(diagnostic['secretsByRule'], {'other': count})
        self.assertEqual(diagnostic['sensitivePathsByReason'], {'sensitive-name': count})
        self.assertEqual(len(diagnostic['secretSamples']), 100)
        self.assertEqual(diagnostic['secretSamplesOmitted'], 7)
        self.assertEqual(diagnostic['sensitivePathSamplesOmitted'], 7)
        self.assertTrue(diagnostic['secretSamples'][0]['location']['nested'])
        self.assertNotIn('CANARY', json.dumps(diagnostic))
        self.assertNotIn(str(self.root), json.dumps(diagnostic))

    def test_invalid_secret_report_fails_without_echoing_fields(self):
        evidence = self.prepare()
        for finding in [None, {}, {'RuleID': 'SECRET_CANARY', 'File': 7},
                        {'RuleID': 'private-key', 'File': 'SECRET_CANARY', 'StartLine': 'SECRET_CANARY'}]:
            with self.subTest(finding=finding), self.assertRaisesRegex(gate.GateError, '^invalid-secret-report$'):
                gate.secret_diagnostics([finding], evidence)

    def test_unmapped_report_location_is_hashed_instead_of_echoed(self):
        evidence = self.prepare()
        diagnostic = gate.secret_diagnostics([{'RuleID': 'private-key',
            'File': '/SECRET_ABSOLUTE_CANARY/../../layer-0/file-0.data', 'StartLine': 1}], evidence)
        self.assertEqual(diagnostic['secretSamples'][0]['location']['class'], 'unmapped')
        self.assertNotIn('CANARY', json.dumps(diagnostic))

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
    def test_secret_exceptions_require_exact_location_and_count(self):
        path = 'opt/investment-python/site-packages/example/runtime.py'
        evidence = {
            'scan_root': Path('/scan'),
            'locations': {'layer-0/file-0.data': {
                'layer': 0, 'entry': 0, 'class': 'python-dependency',
                'pathSha256': hashlib.sha256(path.encode()).hexdigest(),
                'fileSha256': hashlib.sha256(b'public fixture').hexdigest(),
            }},
        }
        finding = {'RuleID': 'generic-api-key', 'File': '/scan/layer-0/file-0.data', 'StartLine': 7}
        exception = {
            'kind': 'gitleaks-finding', 'rule': 'generic-api-key', 'sourceClass': 'python-dependency',
            'pathSha256': evidence['locations']['layer-0/file-0.data']['pathSha256'],
            'fileSha256': evidence['locations']['layer-0/file-0.data']['fileSha256'],
            'line': 7, 'count': 2, 'package': 'example==1.0.0', 'reason': 'public-runtime-constant',
            'reviewedBy': 'test-reviewer', 'expiresAt': '2099-01-01T00:00:00Z',
        }

        remaining, applied = gate.apply_secret_exceptions([finding, finding], evidence, [exception])
        self.assertEqual(remaining, [])
        self.assertEqual(applied, 2)
        remaining, applied = gate.apply_secret_exceptions([finding, finding, finding], evidence, [exception])
        self.assertEqual(remaining, [finding])
        self.assertEqual(applied, 2)
        with self.assertRaisesRegex(gate.GateError, '^unused-secret-exception$'):
            gate.apply_secret_exceptions([finding], evidence, [exception])
        for field, value in [('rule', 'private-key'), ('sourceClass', 'application'),
                             ('pathSha256', '0' * 64), ('fileSha256', '1' * 64), ('line', 8)]:
            changed = {**exception, field: value, 'count': 1}
            with self.subTest(field=field), self.assertRaisesRegex(gate.GateError, '^unused-secret-exception$'):
                gate.apply_secret_exceptions([finding], evidence, [changed])

    def test_policy_rejects_expired_duplicate_and_broad_exceptions(self):
        base = {
            'kind': 'gitleaks-finding', 'rule': 'generic-api-key', 'sourceClass': 'python-dependency',
            'pathSha256': '0' * 64, 'fileSha256': '1' * 64, 'line': 7, 'count': 1,
            'package': 'example==1.0.0', 'reason': 'public-runtime-constant',
            'reviewedBy': 'test-reviewer', 'expiresAt': '2099-01-01T00:00:00Z',
        }
        value = {'schemaVersion': 3, 'blockingSeverities': ['UNKNOWN', 'HIGH', 'CRITICAL'],
                 'exceptions': [base], 'vulnerabilityExceptions': [], 'scanners': {
                     'gitleaks': {'version': '8.30.1', 'url': 'https://example.invalid/gitleaks', 'sha256': '2' * 64},
                     'trivy': {'version': '0.74.0', 'url': 'https://example.invalid/trivy', 'sha256': '3' * 64},
                 }}
        self.assertEqual(gate.validate_policy(value)['exceptions'], [base])
        for exceptions in ([base, base], [{**base, 'expiresAt': '2020-01-01T00:00:00Z'}],
                           [{**base, 'pathSha256': '*'}], [{**base, 'unexpected': True}]):
            with self.subTest(exceptions=exceptions), self.assertRaisesRegex(gate.GateError, '^unapproved-policy$'):
                gate.validate_policy({**value, 'exceptions': exceptions})

    def test_vulnerability_policy_rejects_broad_or_expired_exceptions(self):
        value = json.loads(gate.POLICY_PATH.read_text())
        exact = vulnerability_exception()
        self.assertEqual(gate.validate_policy({**value, 'vulnerabilityExceptions': [exact]})[
            'vulnerabilityExceptions'], [exact])
        for exception in ({**exact, 'package': '*'}, {**exact, 'installedVersion': '*'},
                          {**exact, 'platform': 'linux/ppc64le'}, {**exact, 'count': 2},
                          {**exact, 'severity': 'HIGH'}, {**exact, 'advisory': 'https://example.invalid'},
                          {**exact, 'expiresAt': '2020-01-01T00:00:00Z'}):
            with self.subTest(exception=exception), self.assertRaisesRegex(gate.GateError, '^unapproved-policy$'):
                gate.validate_policy({**value, 'vulnerabilityExceptions': [exception]})
        with self.assertRaisesRegex(gate.GateError, '^unapproved-policy$'):
            gate.validate_policy({**value, 'vulnerabilityExceptions': [exact, exact]})

    def test_vulnerability_exception_requires_exact_inventory_and_preserves_other_findings(self):
        exact = vulnerability_exception()
        finding = {'VulnerabilityID': exact['id'], 'PkgName': exact['package'],
                   'InstalledVersion': exact['installedVersion'], 'Severity': exact['severity']}
        report = {'Results': [{'Class': 'os-pkgs', 'Type': 'debian',
                              'Packages': [{'Name': 'libc6', 'Version': exact['installedVersion']}],
                              'Vulnerabilities': [finding,
                                  {'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'}]}]}
        with patch.object(gate, 'require_amd64_unaffected_advisory') as check:
            filtered, applied = gate.apply_vulnerability_exceptions(report, [exact], 'linux/amd64')
        self.assertEqual(applied, 1)
        self.assertEqual(filtered['Results'][0]['Vulnerabilities'],
                         [{'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'}])
        self.assertEqual(len(report['Results'][0]['Vulnerabilities']), 2)
        check.assert_called_once_with(gate.CVE_97399_ADVISORY)
        with self.assertRaisesRegex(gate.GateError, '^unexpected-platform$'):
            gate.apply_vulnerability_exceptions(report, [exact], 'linux/ppc64le')
        for change in ({'PkgName': 'libc-bin'}, {'InstalledVersion': '2.45'},
                       {'Severity': 'HIGH'}, {'VulnerabilityID': 'CVE-2099-1234'}):
            altered = {**report, 'Results': [{**report['Results'][0],
                'Vulnerabilities': [{**finding, **change}]}]}
            with self.subTest(change=change), self.assertRaisesRegex(
                    gate.GateError, '^unused-vulnerability-exception$'):
                gate.apply_vulnerability_exceptions(altered, [exact], 'linux/amd64')
        with self.assertRaisesRegex(gate.GateError, '^unused-vulnerability-exception$'):
            gate.apply_vulnerability_exceptions({**report, 'Results': [{**report['Results'][0],
                'Packages': [{'Name': 'libc6', 'Version': '2.45'}]}]}, [exact], 'linux/amd64')
        with self.assertRaisesRegex(gate.GateError, '^unused-vulnerability-exception$'):
            gate.apply_vulnerability_exceptions({**report, 'Results': [{**report['Results'][0],
                'Vulnerabilities': []}]}, [exact], 'linux/amd64')
        with patch.object(gate, 'require_amd64_unaffected_advisory'):
            filtered, applied = gate.apply_vulnerability_exceptions({**report, 'Results': [{**report['Results'][0],
                'Vulnerabilities': [finding, finding]}]}, [exact], 'linux/amd64')
        self.assertEqual(applied, 1)
        self.assertEqual(filtered['Results'][0]['Vulnerabilities'], [finding])

    def test_official_advisory_change_or_unavailability_blocks_exception(self):
        advisory = {'cveMetadata': {'cveId': 'CVE-2026-97399', 'state': 'PUBLISHED'},
                    'containers': {'cna': {'affected': [{
                        'vendor': 'The GNU C Library', 'product': 'glibc', 'platforms': ['Power8'],
                        'versions': [{'status': 'affected', 'version': '2.24',
                                      'lessThan': '2.45', 'versionType': 'custom'}],
                        'defaultStatus': 'unaffected'}]}}}
        with patch.object(gate.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(advisory).encode())):
            gate.require_amd64_unaffected_advisory(gate.CVE_97399_ADVISORY)
        advisory['containers']['cna']['affected'][0]['platforms'] = ['Power8', 'amd64']
        with patch.object(gate.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(advisory).encode())):
            with self.assertRaisesRegex(gate.GateError, '^unverified-vulnerability-exception$'):
                gate.require_amd64_unaffected_advisory(gate.CVE_97399_ADVISORY)
        with patch.object(gate.urllib.request, 'urlopen', side_effect=OSError('SECRET_CANARY')):
            with self.assertRaisesRegex(gate.GateError, '^unverified-vulnerability-exception$') as failure:
                gate.require_amd64_unaffected_advisory(gate.CVE_97399_ADVISORY)
            self.assertNotIn('CANARY', str(failure.exception))

    def test_vulnerability_diagnostics_only_echo_recognized_public_identifiers(self):
        report = {'Results': [{'Vulnerabilities': [
            {'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'},
            {'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'},
            {'VulnerabilityID': 'SECRET_ID_CANARY', 'Severity': 'CRITICAL'},
            {'VulnerabilityID': 'CVE-2099-9999', 'Severity': 'LOW'},
        ]}]}
        values = gate.blocking_vulnerability_ids(report, ('HIGH', 'CRITICAL', 'UNKNOWN'))
        self.assertEqual(values[0], {'id': 'CVE-2099-1234', 'findings': 2})
        self.assertEqual(values[1]['id'], 'sha256:' + hashlib.sha256(b'SECRET_ID_CANARY').hexdigest())
        self.assertNotIn('CANARY', json.dumps(values))

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

    def test_trivy_severity_source_notice_is_not_an_incomplete_scan(self):
        notice = (b'2026-09-21T08:00:00Z\tWARN\tUsing severities from other vendors for some vulnerabilities. '
                  b'Read https://trivy.dev/docs/v0.74/guide/scanner/vulnerability#severity-selection for details.\n')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            success = subprocess.CompletedProcess([], 0, b'', notice)
            with patch.object(gate.subprocess, 'run', return_value=success):
                self.assertEqual(gate.run_scanner(['/tools/trivy', 'image'], root).returncode, 0)
                with self.assertRaises(gate.GateError):
                    gate.run_scanner(['/tools/other-scanner', 'image'], root)
            for diagnostic in (notice + b'WARN archive could not be opened SECRET_CANARY',
                               notice.replace(b'other vendors', b'unexpected source SECRET_CANARY')):
                with patch.object(gate.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', diagnostic)):
                    with self.assertRaisesRegex(gate.GateError, '^scanner-incomplete$'):
                        gate.run_scanner(['/tools/trivy', 'image'], root)


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.policy_path = self.root / 'policy.json'
        policy_value = json.loads(gate.POLICY_PATH.read_text())
        policy_value['exceptions'] = []
        policy_value['vulnerabilityExceptions'] = []
        self.policy_path.write_text(json.dumps(policy_value))
        policy_patch = patch.object(gate, 'POLICY_PATH', self.policy_path)
        policy_patch.start()
        self.addCleanup(policy_patch.stop)
        self.archive, self.image, self.revision, self.layers = fixture(self.root)
        self.summary = self.root / 'summary.json'
        self.mode = 'clean'
        self.output = io.StringIO()
        self.vulnerability_scans = 0

    def scanner(self, command, cwd, **kwargs):
        from datetime import datetime, timezone
        tool = Path(command[0]).name
        if command[1] in ('version', '--version'):
            return subprocess.CompletedProcess(command, 0, b'8.30.1' if tool == 'gitleaks' else b'Version: 0.74.0', b'')
        if tool == 'gitleaks':
            if self.mode == 'no-secret-report':
                return subprocess.CompletedProcess(command, 0, b'', b'')
            report = Path(command[command.index('--report-path') + 1])
            report.write_text(json.dumps([{'RuleID': 'private-key', 'File': 'layer-0/file-0.data',
                                           'StartLine': 1, 'Secret': 'SECRET_REPORT_CANARY'}]
                                         if self.mode in ('secret', 'secret-and-unfixed') else []))
        else:
            self.vulnerability_scans += 1
            report = Path(command[command.index('--output') + 1])
            if self.mode != 'no-vuln-report':
                report.write_text(json.dumps({'SchemaVersion': 2, 'Trivy': {'Version': '0.74.0'},
                    'ArtifactType': 'container_image',
                    'Metadata': {'ImageID': self.image if self.mode != 'identity' else 'wrong',
                                 'DiffIDs': self.layers, 'OS': {'Family': 'debian'}},
                    'Results': [{'Class': 'lang-pkgs', 'Type': kind, 'Packages': [{'Name': 'example'}]}
                                for kind in ('node-pkg', 'python-pkg')] +
                               [{'Class': 'os-pkgs', 'Type': 'debian',
                                 'Packages': [{'Name': 'example'},
                                              {'Name': 'libc6', 'Version': '2.41-12+deb13u4'}],
                                 'Vulnerabilities': (
                                     ([{'VulnerabilityID': 'CVE-2026-97399', 'Severity': 'UNKNOWN',
                                        'PkgName': 'libc6', 'InstalledVersion': '2.41-12+deb13u4'}]
                                      if self.mode in ('cve', 'cve-and-unfixed') else [])
                                     + ([{'VulnerabilityID': 'CVE-2099-1234', 'Severity': 'HIGH'}]
                                        if self.mode in ('unfixed', 'secret-and-unfixed',
                                                         'cve-and-unfixed') else []))}]}))
            cache = Path(command[command.index('--cache-dir') + 1]) / 'db'
            cache.mkdir(parents=True)
            (cache / 'metadata.json').write_text(json.dumps({'UpdatedAt': datetime.now(timezone.utc).isoformat()}))
        return subprocess.CompletedProcess(command, 10 if tool == 'gitleaks' and self.mode in ('secret', 'secret-and-unfixed') else 0, b'', b'')

    def invoke(self):
        with patch.object(gate.subprocess, 'run', side_effect=self.scanner), redirect_stdout(self.output):
            return gate.scan(self.archive, self.image, self.revision, self.root, self.root, self.summary)

    def test_secret_and_path_only_failures_still_scan_vulnerabilities_and_do_not_publish(self):
        for mode in ('secret', 'path-only'):
            self.mode = mode
            self.output = io.StringIO()
            if mode == 'path-only':
                self.archive, self.image, self.revision, self.layers = fixture(
                    self.root, layers=[[('app/SECRET_PATH_CANARY/.env', 'opaque', 'file')]])
            with self.assertRaisesRegex(gate.GateError, 'security-findings-block-publication'):
                self.invoke()
            diagnostic, final = map(json.loads, self.output.getvalue().splitlines())
            self.assertIs(diagnostic['passed'], False)
            self.assertEqual(diagnostic['revision'], self.revision)
            self.assertEqual(diagnostic['archiveSha256'], gate.digest(self.archive))
            self.assertEqual(diagnostic['secretFindings'], int(mode == 'secret'))
            self.assertEqual(diagnostic['sensitivePaths'], int(mode == 'path-only'))
            self.assertEqual(diagnostic['vulnerabilityScan'], 'pending')
            self.assertEqual(final['kind'], 'image-security-result')
            self.assertIs(final['passed'], False)
            self.assertNotIn('CANARY', self.output.getvalue())
            self.assertFalse(json.loads(self.summary.read_text())['passed'])
            self.assertEqual(self.vulnerability_scans, 1 if mode == 'secret' else 2)
            with self.assertRaises(gate.GateError):
                gate.verify_summary(self.summary, self.archive, self.image, self.revision)
            self.assertFalse(any(p.name.startswith('image-security-') for p in self.root.iterdir()))

    def test_combined_findings_are_reported_in_one_run_without_becoming_publishable(self):
        self.mode = 'secret-and-unfixed'
        with self.assertRaisesRegex(gate.GateError, 'security-findings-block-publication'):
            self.invoke()
        final = json.loads(self.output.getvalue().splitlines()[-1])
        self.assertEqual(final['secretFindings'], 1)
        self.assertEqual(final['vulnerabilities']['HIGH'], 1)
        self.assertEqual(final['blockingVulnerabilityIds'], [{'id': 'CVE-2099-1234', 'findings': 1}])
        self.assertIs(final['passed'], False)
        self.assertNotIn('CANARY', self.output.getvalue())

    def test_exact_reviewed_secret_exception_passes_and_is_audited(self):
        self.mode = 'secret'
        policy_value = json.loads(self.policy_path.read_text())
        path = 'app/safe.txt'
        policy_value['exceptions'] = [{
            'kind': 'gitleaks-finding', 'rule': 'private-key', 'sourceClass': 'application',
            'pathSha256': hashlib.sha256(path.encode()).hexdigest(),
            'fileSha256': hashlib.sha256(b'safe').hexdigest(), 'line': 1, 'count': 1,
            'package': 'fixture==1.0.0', 'reason': 'public-runtime-constant',
            'reviewedBy': 'test-reviewer', 'expiresAt': '2099-01-01T00:00:00Z',
        }]
        self.policy_path.write_text(json.dumps(policy_value))

        result = self.invoke()

        self.assertTrue(result['passed'])
        self.assertEqual(result['secretFindingsDetected'], 1)
        self.assertEqual(result['secretExceptionsApplied'], 1)
        self.assertEqual(result['secretFindings'], 0)
        gate.verify_summary(self.summary, self.archive, self.image, self.revision)
        self.assertNotIn('CANARY', self.output.getvalue())

    def test_exact_cve_exception_is_audited_and_other_high_still_blocks(self):
        self.mode = 'cve'
        policy_value = json.loads(self.policy_path.read_text())
        policy_value['vulnerabilityExceptions'] = [vulnerability_exception()]
        self.policy_path.write_text(json.dumps(policy_value))
        with patch.object(gate, 'require_amd64_unaffected_advisory') as advisory:
            result = self.invoke()
            gate.verify_summary(self.summary, self.archive, self.image, self.revision)
        self.assertEqual(advisory.call_count, 2)
        advisory.assert_called_with(gate.CVE_97399_ADVISORY)
        self.assertEqual(result['vulnerabilities']['UNKNOWN'], 1)
        self.assertEqual(result['remainingVulnerabilities']['UNKNOWN'], 0)
        self.assertEqual(result['vulnerabilityExceptionsApplied'], 1)
        self.assertEqual(json.loads(self.output.getvalue())['blockingVulnerabilityIds'], [])
        forged = json.loads(self.summary.read_text())
        forged['vulnerabilityExceptionsApplied'] = 0
        self.summary.write_text(json.dumps(forged))
        with self.assertRaisesRegex(gate.GateError, '^security-summary-not-passed$'):
            gate.verify_summary(self.summary, self.archive, self.image, self.revision)
        self.mode = 'cve-and-unfixed'
        self.output = io.StringIO()
        with patch.object(gate, 'require_amd64_unaffected_advisory'):
            with self.assertRaisesRegex(gate.GateError, '^security-findings-block-publication$'):
                self.invoke()
        blocked = json.loads(self.output.getvalue())
        self.assertEqual(blocked['blockingVulnerabilityIds'],
                         [{'id': 'CVE-2099-1234', 'findings': 1}])
        self.assertEqual(blocked['remainingVulnerabilities']['HIGH'], 1)
        self.assertFalse(blocked['passed'])

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
