"""Reject untrusted workflow runs and mismatched published-image manifests."""

import unittest
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

import ci


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "run_attempt": 1, "status": "completed", "conclusion": "success",
                    "event": "push", "head_branch": "master", "head_sha": "a" * 40,
                    "path": ".github/workflows/investment-container.yml",
                    "repository": {"full_name": ci.REPO}, "head_repository": {"full_name": ci.REPO}}
        self.manifest = {"repository": ci.REPO, "run_id": 123, "run_attempt": 1,
                         "sha": "a" * 40, "image_id": "sha256:" + "b" * 64,
                         "image": ci.IMAGE_REPO + "@sha256:" + "c" * 64}

    def test_mainline_publication_is_accepted(self):
        ci.validate_run(self.run)
        self.assertEqual(ci.validate_manifest(self.manifest, self.run), self.manifest["image"])

    def test_pr_fork_wrong_workflow_and_failed_run_are_rejected(self):
        for key, value in [("event", "pull_request"), ("head_branch", "feature"),
                           ("status", "in_progress"), ("conclusion", "failure"),
                           ("path", ".github/workflows/other.yml"),
                           ("head_repository", {"full_name": "attacker/fork"}),
                           ("head_sha", "bad\ninjection")]:
            with self.subTest(key=key), self.assertRaises(ci.CandidateError):
                ci.validate_run({**self.run, key: value})

    def test_manifest_must_match_exact_run_attempt_and_sha(self):
        for key, value in [("run_id", 321), ("run_attempt", 2), ("sha", "d" * 40),
                           ("repository", "other/repo"), ("image_id", "invalid"),
                           ("image", ci.IMAGE_REPO + ":latest"),
                           ("image", "ghcr.io/other/image@sha256:" + "c" * 64)]:
            with self.subTest(key=key), self.assertRaises(ci.CandidateError):
                ci.validate_manifest({**self.manifest, key: value}, self.run)

    def test_missing_protection_and_broad_branch_policy_are_rejected(self):
        environment = {"name": "Production", "can_admins_bypass": False,
                       "protection_rules": [{"type": "required_reviewers", "reviewers": [{"type": "User"}]}],
                       "deployment_branch_policy": {"custom_branch_policies": True}}
        policies = {"branch_policies": [{"name": "master", "type": "branch"}]}
        ci.validate_environment(environment, policies)
        for key, value in [("name", "production"), ("can_admins_bypass", True),
                           ("protection_rules", []), ("deployment_branch_policy", None)]:
            with self.subTest(key=key), self.assertRaises(ci.CandidateError):
                ci.validate_environment({**environment, key: value}, policies)
        with self.assertRaises(ci.CandidateError):
            ci.validate_environment(environment, {"branch_policies": [{"name": "*", "type": "branch"}]})

    def test_preflight_only_emits_verified_registry_identity(self):
        environment = {"name": "Production", "can_admins_bypass": False,
                       "protection_rules": [{"type": "required_reviewers", "reviewers": [{"type": "User"}]}],
                       "deployment_branch_policy": {"custom_branch_policies": True}}
        responses = {"actions/runs/123": self.run,
                     "compare/" + "a" * 40 + "...master": {"status": "ahead"},
                     "environments/Production": environment,
                     "environments/Production/deployment-branch-policies": {
                         "branch_policies": [{"name": "master", "type": "branch"}]}}

        def download(args, **kwargs):
            self.assertIn("investment-container-published-123-1", args)
            (Path(args[-1]) / "published-image.json").write_text(json.dumps(self.manifest))

        for actual_digest in [self.manifest["image_id"], "sha256:" + "d" * 64]:
            with self.subTest(digest=actual_digest), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"
                with patch.dict(os.environ, {"BUILD_RUN_ID": "123", "GITHUB_OUTPUT": str(output),
                                             "GITHUB_STEP_SUMMARY": str(Path(directory) / "summary")}), \
                     patch.object(ci, "api", side_effect=responses.__getitem__), \
                     patch.object(ci.subprocess, "run", side_effect=download), \
                     patch.object(ci.subprocess, "check_output", return_value=json.dumps({"config": {"digest": actual_digest}})) as inspect:
                    if actual_digest == self.manifest["image_id"]:
                        ci.preflight()
                        self.assertIn("image=" + self.manifest["image"], output.read_text())
                        self.assertEqual(inspect.call_args.args[0], ["docker", "buildx", "imagetools", "inspect",
                                                                     self.manifest["image"], "--raw"])
                    else:
                        with self.assertRaisesRegex(ci.CandidateError, "smoke-tested"):
                            ci.preflight()
                        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
