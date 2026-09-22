"""Fail-closed Docker-save gate. Never runs image code or prints scanner material."""
import argparse
from collections import Counter
from datetime import datetime, timezone, timedelta
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

POLICY_PATH = Path(__file__).with_name('image-security-policy.json')
MAX_TOTAL_BYTES = 8 * 1024**3
MAX_FILE_BYTES = 2 * 1024**3
MAX_ENTRIES = 250000
MAX_DIAGNOSTIC_SAMPLES = 100
# Only these rule identifiers may appear in public diagnostics or reviewed exact exceptions.
DIAGNOSTIC_RULE_IDS = frozenset(('generic-api-key', 'private-key'))
SECRET_EXCEPTION_KEYS = frozenset(('kind', 'rule', 'sourceClass', 'pathSha256', 'fileSha256', 'line',
                                   'count', 'package', 'reason', 'reviewedBy', 'expiresAt'))
SECRET_EXCEPTION_REASONS = frozenset(('generated-code-expression', 'public-runtime-constant'))
SECRET_SOURCE_CLASSES = frozenset(('application', 'image-metadata', 'layer-metadata', 'node-dependency',
                                   'other', 'python-dependency'))
SEVERITIES = ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
SENSITIVE_PATH = re.compile(
    r'(^|/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|\.netrc|\.pypirc|credentials\.json|'
    r'web-admin-password[.-]hash|id_rsa[^/]*|id_ed25519[^/]*)(/|$)|\.(sqlite3?|db|jsonl|pabackup)$', re.I)


class GateError(Exception):
    """Only fixed, non-sensitive error categories may cross the CLI boundary."""


def require(condition, code):
    if not condition:
        raise GateError(code)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), 'missing-report-or-metadata')
    require(path.stat().st_size < 256 * 1024**2, 'report-too-large')
    try:
        return json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        raise GateError('invalid-json') from None


def exception_key(exception):
    return (exception['rule'], exception['sourceClass'], exception['pathSha256'],
            exception['fileSha256'], exception['line'])


def validate_policy(value):
    require(isinstance(value, dict) and set(value) == {
        'schemaVersion', 'blockingSeverities', 'exceptions', 'scanners'
    } and value.get('schemaVersion') == 2, 'unapproved-policy')
    require(value.get('blockingSeverities') == ['UNKNOWN', 'HIGH', 'CRITICAL'], 'unapproved-policy')
    exceptions = value.get('exceptions')
    require(isinstance(exceptions, list) and len(exceptions) <= MAX_DIAGNOSTIC_SAMPLES, 'unapproved-policy')
    keys = []
    for exception in exceptions:
        require(isinstance(exception, dict) and set(exception) == SECRET_EXCEPTION_KEYS
                and exception.get('kind') == 'gitleaks-finding'
                and exception.get('rule') in DIAGNOSTIC_RULE_IDS
                and exception.get('sourceClass') in SECRET_SOURCE_CLASSES
                and re.fullmatch(r'[0-9a-f]{64}', exception.get('pathSha256', '')) is not None
                and re.fullmatch(r'[0-9a-f]{64}', exception.get('fileSha256', '')) is not None
                and type(exception.get('line')) is int and 0 < exception['line'] <= 2147483647
                and type(exception.get('count')) is int and 0 < exception['count'] <= MAX_DIAGNOSTIC_SAMPLES
                and isinstance(exception.get('package'), str) and 0 < len(exception['package']) <= 256
                and exception.get('reason') in SECRET_EXCEPTION_REASONS
                and isinstance(exception.get('reviewedBy'), str) and 0 < len(exception['reviewedBy']) <= 256
                and isinstance(exception.get('expiresAt'), str), 'unapproved-policy')
        try:
            expires = datetime.fromisoformat(exception['expiresAt'].replace('Z', '+00:00'))
        except ValueError:
            raise GateError('unapproved-policy') from None
        require(expires.utcoffset() == timedelta(0) and datetime.now(timezone.utc) < expires,
                'unapproved-policy')
        keys.append(exception_key(exception))
    require(len(keys) == len(set(keys)), 'unapproved-policy')
    scanners = value.get('scanners')
    require(isinstance(scanners, dict) and set(scanners) == {'gitleaks', 'trivy'}, 'unapproved-policy')
    for specification in scanners.values():
        require(isinstance(specification, dict) and set(specification) == {'version', 'url', 'sha256'}
                and isinstance(specification['version'], str) and specification['version']
                and isinstance(specification['url'], str) and specification['url'].startswith('https://')
                and re.fullmatch(r'[0-9a-f]{64}', specification['sha256']) is not None,
                'unapproved-policy')
    return value


def policy():
    return validate_policy(read_json(POLICY_PATH))


def safe_name(name):
    require(isinstance(name, str) and name and '\\' not in name and '\x00' not in name, 'unsafe-archive-path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts, 'unsafe-archive-path')
    return str(path)


class Budget:
    def __init__(self):
        self.bytes = 0
        self.entries = 0

    def charge(self, member):
        self.entries += 1
        self.bytes += member.size
        require(0 <= member.size <= MAX_FILE_BYTES and self.bytes <= MAX_TOTAL_BYTES
                and self.entries <= MAX_ENTRIES, 'archive-resource-limit')


def copy_member(archive, member, target):
    # No tar extraction API: no symlinks, hardlinks, permissions or device nodes are materialized.
    require(member.isfile() and not member.issparse(), 'unsupported-archive-entry')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with archive.extractfile(member) as source, target.open('xb') as output:
        shutil.copyfileobj(source, output, 1024 * 1024)
    require(target.stat().st_size == member.size, 'truncated-archive-entry')


def archive_suffix(prefix):
    """Archive recognition uses bytes, not misleading names such as dpkg's builtins.7.gz."""
    for magic, suffix in [(b'\x1f\x8b', '.gz'), (b'PK\x03\x04', '.zip'), (b'BZh', '.bz2'),
                          (b'\xfd7zXZ\x00', '.xz'), (b'\x28\xb5\x2f\xfd', '.zst'),
                          (b'7z\xbc\xaf\x27\x1c', '.7z'), (b'Rar!', '.rar')]:
        if prefix.startswith(magic):
            return suffix
    return '.tar' if prefix[257:262] == b'ustar' else '.data'


def path_location(path, layer, entry):
    parts = PurePosixPath(path).parts
    category = ('python-dependency' if 'site-packages' in parts else
                'node-dependency' if 'node_modules' in parts else
                'application' if path.startswith(('opt/dsh/', 'app/')) else 'other')
    return {'layer': layer, 'entry': entry, 'class': category,
            'pathSha256': hashlib.sha256(path.encode()).hexdigest()}


def secret_finding_location(finding, evidence):
    require(isinstance(finding, dict), 'invalid-secret-report')
    rule, file, line = finding.get('RuleID'), finding.get('File'), finding.get('StartLine', 0)
    require(isinstance(rule, str) and 0 < len(rule) <= 256
            and isinstance(file, str) and 0 < len(file) <= 16384
            and type(line) is int and 0 <= line <= 2147483647, 'invalid-secret-report')
    prefix = str(evidence['scan_root']) + '/'
    relative = file[len(prefix):] if file.startswith(prefix) else file
    # Gitleaks separates archive members with '!'. Only the known outer scan file is resolved.
    outer = relative.split('!', 1)[0]
    location = evidence['locations'].get(outer)
    if location is None:
        location = {'class': 'unmapped', 'scanPathSha256': hashlib.sha256(relative.encode()).hexdigest()}
    return rule, line, {**location, 'nested': outer != relative}


def apply_secret_exceptions(findings, evidence, exceptions):
    """Remove only the authorized count of exact findings; stale or unused exceptions fail closed."""
    require(isinstance(findings, list), 'invalid-secret-report')
    expected = Counter({exception_key(exception): exception['count'] for exception in exceptions})
    applied, remaining = Counter(), []
    for finding in findings:
        rule, line, location = secret_finding_location(finding, evidence)
        key = (rule, location.get('class'), location.get('pathSha256'), location.get('fileSha256'), line)
        if not location['nested'] and applied[key] < expected[key]:
            applied[key] += 1
        else:
            remaining.append(finding)
    require(applied == expected, 'unused-secret-exception')
    return remaining, sum(applied.values())


def secret_diagnostics(findings, evidence):
    """Bounded, allowlisted projection; never return report strings or secret fingerprints."""
    require(isinstance(findings, list), 'invalid-secret-report')
    counts, samples = Counter(), []
    for finding in findings:
        rule, line, location = secret_finding_location(finding, evidence)
        label = rule if rule in DIAGNOSTIC_RULE_IDS else 'other'
        counts[label] += 1
        if len(samples) >= MAX_DIAGNOSTIC_SAMPLES:
            continue
        sample = {'rule': label, 'line': line, 'location': location}
        if label == 'other':
            sample['ruleIdSha256'] = hashlib.sha256(rule.encode()).hexdigest()
        samples.append(sample)
    return {'secretFindings': len(findings), 'sensitivePaths': evidence['sensitive_paths'],
            'secretsByRule': dict(sorted(counts.items())),
            'sensitivePathsByReason': dict(sorted(evidence['sensitive_reasons'].items())),
            'secretSamples': samples, 'secretSamplesOmitted': len(findings) - len(samples),
            'sensitivePathSamples': evidence['sensitive_samples'],
            'sensitivePathSamplesOmitted': evidence['sensitive_paths'] - len(evidence['sensitive_samples'])}


def prepare_archive(archive_path, work, image_id, revision):
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) is not None
            and re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'invalid-expected-identity')
    outer, scan_root = work / 'outer', work / 'scan'
    outer.mkdir(parents=True, mode=0o700)
    scan_root.mkdir(mode=0o700)
    budget = Budget()
    with tarfile.open(archive_path, 'r|*') as archive:
        for member in archive:
            budget.charge(member)
            name = safe_name(member.name)
            if member.isdir():
                continue
            copy_member(archive, member, outer / name)
    manifest = read_json(outer / 'manifest.json')
    require(isinstance(manifest, list) and len(manifest) == 1, 'ambiguous-image')
    entry = manifest[0]
    config_path = outer / safe_name(entry['Config'])
    require('sha256:' + digest(config_path) == image_id, 'config-identity-mismatch')
    config = read_json(config_path)
    require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'unexpected-platform')
    require(config.get('config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == revision,
            'source-identity-mismatch')
    require(entry.get('RepoTags') == ['pa-investment-research:' + revision], 'tag-identity-mismatch')
    layer_names, diff_ids = entry['Layers'], config['rootfs']['diff_ids']
    require(isinstance(layer_names, list) and layer_names and len(layer_names) == len(diff_ids)
            and len(layer_names) <= 128, 'invalid-layer-manifest')
    shutil.copyfile(config_path, scan_root / 'image-config-history.json')
    shutil.copyfile(outer / 'manifest.json', scan_root / 'image-manifest.json')
    locations = {name: {'class': 'image-metadata'}
                 for name in ('image-config-history.json', 'image-manifest.json')}
    # Additional OCI metadata is also scanned; binary layer blobs are scanned through their entries below.
    referenced = {safe_name(entry['Config']), *(safe_name(name) for name in layer_names), 'manifest.json'}
    for index, path in enumerate(outer.rglob('*')):
        if path.is_file() and path.relative_to(outer).as_posix() not in referenced:
            shutil.copyfile(path, scan_root / f'outer-metadata-{index}.txt')
            locations[f'outer-metadata-{index}.txt'] = {'class': 'image-metadata'}
    sensitive_paths = files = 0
    sensitive_reasons, sensitive_samples = Counter(), []
    for index, name in enumerate(layer_names):
        blob = outer / safe_name(name)
        # Docker-save normally stores uncompressed tar, but diff IDs always hash the uncompressed bytes.
        with blob.open('rb') as stream:
            compressed = stream.read(2) == b'\x1f\x8b'
        layer = blob
        if compressed:
            layer = work / f'layer-{index}.tar'
            with gzip.open(blob, 'rb') as source, layer.open('xb') as target:
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    require(size <= MAX_TOTAL_BYTES, 'archive-resource-limit')
                    target.write(chunk)
        require('sha256:' + digest(layer) == diff_ids[index], 'layer-identity-mismatch')
        layer_root = scan_root / f'layer-{index}'
        layer_root.mkdir(mode=0o700)
        locations[f'layer-{index}/headers.jsonl'] = {'class': 'layer-metadata', 'layer': index}
        with tarfile.open(layer, 'r|') as archive, (layer_root / 'headers.jsonl').open('x') as headers:
            for serial, member in enumerate(archive):
                budget.charge(member)
                path = safe_name(member.name)
                # Headers include names, links, owner names and PAX data; never printed or uploaded.
                headers.write(json.dumps({'name': member.name, 'link': member.linkname, 'uname': member.uname,
                                          'gname': member.gname, 'pax': member.pax_headers}) + '\n')
                if member.isdir():
                    continue
                require(member.isfile() or member.issym() or member.islnk(), 'unsupported-layer-entry')
                location = path_location(path, index, serial)
                reason = ('sensitive-name' if SENSITIVE_PATH.search(path) else
                          'runtime-state' if path.startswith(('var/lib/dsh/', 'run/secrets/')) and member.size > 0 else
                          'npm-config' if PurePosixPath(path).name == '.npmrc' and member.size > 0 else None)
                if reason:
                    sensitive_paths += 1
                    sensitive_reasons[reason] += 1
                    if len(sensitive_samples) < MAX_DIAGNOSTIC_SAMPLES:
                        sensitive_samples.append({'reason': reason, 'location': location})
                if member.isfile():
                    # Ordinals retain duplicate/overwritten files and case variants on every host filesystem.
                    # Keep suffixes for nested archive recognition. Never use image paths as host paths.
                    target = layer_root / f'file-{serial}.data'
                    copy_member(archive, member, target)
                    with target.open('rb') as source:
                        suffix = archive_suffix(source.read(512))
                    if suffix != '.data':
                        target = target.rename(layer_root / f'file-{serial}{suffix}')
                    location['fileSha256'] = digest(target)
                    locations[f'layer-{index}/file-{serial}{suffix}'] = location
                    files += 1
        if compressed:
            layer.unlink()
    return {'scan_root': scan_root, 'diff_ids': diff_ids, 'layers': len(layer_names),
            'files': files, 'sensitive_paths': sensitive_paths, 'locations': locations,
            'sensitive_reasons': sensitive_reasons, 'sensitive_samples': sensitive_samples}


def scanner_env(root):
    # Do not inherit scanner config overrides, tokens, Docker credentials or host home configuration.
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root),
            'TMPDIR': str(root), 'NO_COLOR': '1', 'TRIVY_DISABLE_TELEMETRY': 'true'}


def run_scanner(command, root, timeout=900, accepted=(0,)):
    try:
        result = subprocess.run(command, cwd=root, env=scanner_env(root), capture_output=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        raise GateError('scanner-timeout-or-unavailable') from None
    require(result.returncode in accepted, 'scanner-error')
    # Some archive/analysis failures only produce diagnostics while returning zero.
    diagnostics = result.stdout + result.stderr
    if result.returncode == 10 and accepted == (0, 10):
        # Gitleaks reports its finding count as a warning; other diagnostics still block.
        diagnostics = re.sub(rb'(?m)^\S+\s+WRN leaks found: [0-9]+\r?$', b'', diagnostics)
    if Path(command[0]).name == 'trivy' and command[1:2] == ['image'] and result.returncode == 0:
        # Trivy's documented severity-source fallback is informational: findings remain in the report.
        # Match only the pinned version's exact notice, never suppress parse/download/archive warnings.
        notice = (b'Using severities from other vendors for some vulnerabilities. '
                  b'Read https://trivy.dev/docs/v0.74/guide/scanner/vulnerability#severity-selection for details.')
        diagnostics = re.sub(rb'(?m)^\S+[ \t]+WARN[ \t]+' + re.escape(notice) + rb'\r?$', b'', diagnostics)
    require(re.search(rb'(?i)\b(?:warn(?:ing)?|wrn|err(?:or)?|fatal)\b', diagnostics) is None,
            'scanner-incomplete')
    return result


def vulnerability_counts(report, image_id, diff_ids):
    require(isinstance(report, dict) and report.get('SchemaVersion') == 2
            and report.get('ArtifactType') == 'container_image', 'invalid-vulnerability-report')
    metadata = report.get('Metadata', {})
    require(metadata.get('ImageID') == image_id and metadata.get('DiffIDs') == diff_ids, 'scan-identity-mismatch')
    results = report.get('Results')
    require(isinstance(results, list) and results and metadata.get('OS', {}).get('Family') == 'debian',
            'missing-package-inventory')
    for category, kind in [('os-pkgs', 'debian'), ('lang-pkgs', 'node-pkg'), ('lang-pkgs', 'python-pkg')]:
        require(any(r.get('Class') == category and r.get('Type') == kind and r.get('Packages') for r in results),
                'missing-package-inventory')
    counts = dict.fromkeys(SEVERITIES, 0)
    for result in results:
        require(isinstance(result, dict), 'invalid-vulnerability-report')
        vulnerabilities = result.get('Vulnerabilities', [])
        require(isinstance(vulnerabilities, list), 'invalid-vulnerability-report')
        for vulnerability in vulnerabilities:
            require(isinstance(vulnerability, dict) and vulnerability.get('Severity') in SEVERITIES
                    and bool(vulnerability.get('VulnerabilityID')), 'invalid-vulnerability-report')
            counts[vulnerability['Severity']] += 1
    return counts


def install_scanners(destination):
    require(not destination.exists(), 'tools-directory-already-exists')
    destination.mkdir(parents=True, mode=0o700)
    for name, specification in policy()['scanners'].items():
        archive_path = destination / (name + '.tar.gz')
        with urllib.request.urlopen(specification['url'], timeout=60) as source, archive_path.open('xb') as output:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                require(total < 200 * 1024**2, 'scanner-download-too-large')
                output.write(chunk)
        require(digest(archive_path) == specification['sha256'], 'scanner-checksum-mismatch')
        with tarfile.open(archive_path, 'r:gz') as archive:
            members = [m for m in archive if m.name == name]
            require(len(members) == 1, 'scanner-binary-missing')
            copy_member(archive, members[0], destination / name)
        (destination / name).chmod(0o700)
        archive_path.unlink()


def blocking_vulnerability_ids(report, severities):
    counts = Counter()
    for result in report['Results']:
        for vulnerability in result.get('Vulnerabilities', []):
            if vulnerability['Severity'] not in severities:
                continue
            identifier = vulnerability['VulnerabilityID']
            require(isinstance(identifier, str), 'invalid-vulnerability-report')
            if not re.fullmatch(r'(?:CVE-[0-9]{4}-[0-9]{4,10}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})', identifier):
                identifier = 'sha256:' + hashlib.sha256(identifier.encode()).hexdigest()
            counts[identifier] += 1
    return [{'id': identifier, 'findings': count} for identifier, count in sorted(counts.items())]


def scan(archive, image_id, revision, tools, work_parent, summary):
    rules = policy()
    summary.unlink(missing_ok=True)
    archive_hash = digest(archive)
    with tempfile.TemporaryDirectory(prefix='image-security-', dir=work_parent) as temporary:
        work = Path(temporary)
        evidence = prepare_archive(archive, work, image_id, revision)
        for name, specification in rules['scanners'].items():
            version = run_scanner([str(tools / name), 'version' if name == 'gitleaks' else '--version'], work, 30)
            require(specification['version'] in version.stdout.decode().split(), 'scanner-version-mismatch')
        empty = work / 'empty-ignore'
        empty.write_text('')
        gitleaks_config = work / 'gitleaks.toml'
        gitleaks_config.write_text('[extend]\nuseDefault = true\n')
        secrets_report = work / 'secrets.json'
        # Exit 10 is exclusively findings. Scan logs stay captured, never persisted to public artifacts.
        secrets_result = run_scanner([str(tools / 'gitleaks'), 'dir', str(evidence['scan_root']), '--config', str(gitleaks_config),
                     '--gitleaks-ignore-path', str(empty), '--ignore-gitleaks-allow', '--redact=100',
                     '--max-archive-depth', '2', '--max-decode-depth', '5', '--max-target-megabytes', '0',
                     '--no-banner', '--no-color', '--log-level', 'warn', '--exit-code', '10',
                     '--timeout', '900', '--report-format', 'json', '--report-path', str(secrets_report)],
                    work, timeout=960, accepted=(0, 10))
        secrets = read_json(secrets_report)
        require(isinstance(secrets, list), 'invalid-secret-report')
        # Raw fields (including redacted Match/Secret) never reach the summary.
        secrets_detected = len(secrets)
        require(secrets_result.returncode == (10 if secrets_detected else 0), 'secret-report-exit-mismatch')
        remaining_secrets, secret_exceptions_applied = apply_secret_exceptions(
            secrets, evidence, rules['exceptions'])
        secrets_count = len(remaining_secrets)
        diagnostic = secret_diagnostics(remaining_secrets, evidence)
        if secrets_count or evidence['sensitive_paths']:
            # Failure diagnostics cannot be used as a passing publication summary.
            print(json.dumps({'schemaVersion': 1, 'kind': 'secret-gate-diagnostics', 'passed': False,
                              'archiveSha256': archive_hash, 'imageId': image_id, 'revision': revision,
                              'vulnerabilityScan': 'pending', **diagnostic}, sort_keys=True), flush=True)
        # Collect both independent results before failing; any finding still prevents artifact upload.
        report = work / 'vulnerabilities.json'
        cache = work / 'trivy-cache'
        config = work / 'trivy.yaml'
        config.write_text('{}\n')
        run_scanner([str(tools / 'trivy'), 'image', '--input', str(archive), '--config', str(config),
                     '--cache-dir', str(cache), '--db-repository', 'ghcr.io/aquasecurity/trivy-db:2',
                     '--java-db-repository', 'ghcr.io/aquasecurity/trivy-java-db:1',
                     '--scanners', 'vuln', '--pkg-types', 'os,library', '--list-all-pkgs',
                     '--ignorefile', str(empty), '--ignore-unfixed=false', '--exit-code', '0',
                     '--timeout', '15m', '--no-progress', '--format', 'json', '--output', str(report)], work, 960)
        data = read_json(report)
        require(data.get('Trivy', {}).get('Version') == rules['scanners']['trivy']['version'], 'scanner-version-mismatch')
        counts = vulnerability_counts(data, image_id, evidence['diff_ids'])
        database = read_json(cache / 'db' / 'metadata.json')
        updated = datetime.fromisoformat(database['UpdatedAt'].replace('Z', '+00:00'))
        require(timedelta(0) <= datetime.now(timezone.utc) - updated <= timedelta(hours=72), 'stale-vulnerability-database')
        require(digest(archive) == archive_hash, 'archive-changed-during-scan')
        blocked = secrets_count + evidence['sensitive_paths'] + sum(counts[s] for s in rules['blockingSeverities'])
        result = {'schemaVersion': 1, 'passed': blocked == 0, 'archiveSha256': archive_hash, 'imageId': image_id,
                  'revision': revision, 'diffIds': evidence['diff_ids'], 'layers': evidence['layers'],
                  'files': evidence['files'], 'secretFindings': secrets_count,
                  'secretFindingsDetected': secrets_detected,
                  'secretExceptionsApplied': secret_exceptions_applied,
                  'sensitivePaths': evidence['sensitive_paths'], 'vulnerabilities': counts,
                  'scanners': {name: spec['version'] for name, spec in rules['scanners'].items()},
                  'databaseUpdatedAt': updated.isoformat(), 'policySha256': digest(POLICY_PATH),
                  'scannedAt': datetime.now(timezone.utc).isoformat()}
        summary.write_text(json.dumps(result, indent=2) + '\n')
        identifiers = blocking_vulnerability_ids(data, rules['blockingSeverities'])
        print(json.dumps({'kind': 'image-security-result', **result,
                          'vulnerabilityScan': 'completed',
                          'blockingVulnerabilityIds': identifiers[:MAX_DIAGNOSTIC_SAMPLES],
                          'blockingVulnerabilityIdsOmitted': max(0, len(identifiers) - MAX_DIAGNOSTIC_SAMPLES)},
                         sort_keys=True), flush=True)
        require(blocked == 0, 'security-findings-block-publication')
        return result


def verify_summary(summary, archive, image_id, revision):
    data = read_json(summary)
    rules = policy()
    require(data.get('schemaVersion') == 1 and data.get('passed') is True
            and data.get('archiveSha256') == digest(archive) and data.get('imageId') == image_id
            and data.get('revision') == revision and data.get('policySha256') == digest(POLICY_PATH),
            'security-summary-identity-mismatch')
    expected_exceptions = sum(exception['count'] for exception in rules['exceptions'])
    require(data.get('secretFindings') == 0
            and data.get('secretFindingsDetected') == expected_exceptions
            and data.get('secretExceptionsApplied') == expected_exceptions
            and data.get('sensitivePaths') == 0
            and all(data.get('vulnerabilities', {}).get(s) == 0 for s in rules['blockingSeverities'])
            and data.get('scanners') == {name: spec['version'] for name, spec in rules['scanners'].items()},
            'security-summary-not-passed')
    scanned = datetime.fromisoformat(data['scannedAt'])
    require(timedelta(0) <= datetime.now(timezone.utc) - scanned <= timedelta(hours=24), 'security-summary-expired')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install', 'scan', 'verify'])
    parser.add_argument('--tools', type=Path)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--image-id-file', type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--work-parent', type=Path)
    parser.add_argument('--summary', type=Path)
    args = parser.parse_args()
    try:
        os.umask(0o077)
        if args.action == 'install':
            install_scanners(args.tools.resolve())
        else:
            image_id = args.image_id_file.read_text().strip()
            if args.action == 'scan':
                scan(args.archive.resolve(), image_id, args.revision, args.tools.resolve(),
                     args.work_parent.resolve(), args.summary.resolve())
            else:
                verify_summary(args.summary, args.archive, image_id, args.revision)
        print('Image security check completed.')
        return 0
    except GateError as error:
        print('Image security gate blocked: ' + str(error))
    except Exception:
        # Archive/parser/network exceptions can contain image data or local paths.
        print('Image security gate blocked: invalid-input-or-operation-failed')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
