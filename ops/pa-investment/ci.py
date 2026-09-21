"""Validate deployment provenance before obtaining production network identity."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


REPO = "PABIPRG/pa-investment-research"
IMAGE_REPO = "ghcr.io/pabiprg/pa-investment-research"


class CandidateError(RuntimeError):
    """A candidate or environment cannot be trusted for deployment."""


def require(condition, message):
    if not condition:
        raise CandidateError(message)


def validate_run(run):
    require(run.get("repository", {}).get("full_name") == REPO
            and run.get("head_repository", {}).get("full_name") == REPO, "build must belong to the public repository")
    require(run.get("path") == ".github/workflows/investment-container.yml", "unexpected build workflow")
    require(run.get("event") in {"push", "workflow_dispatch"} and run.get("head_branch") == "master",
            "only master builds are deployable")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "build must have succeeded")
    require(re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")), "invalid build SHA")


def validate_manifest(manifest, run):
    validate_run(run)
    require(manifest.get("repository") == REPO and manifest.get("sha") == run["head_sha"]
            and manifest.get("run_id") == run["id"] and manifest.get("run_attempt") == run["run_attempt"],
            "manifest does not belong to this build attempt")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", manifest.get("image_id", "")), "invalid image config ID")
    image = manifest.get("image", "")
    require(re.fullmatch(re.escape(IMAGE_REPO) + r"@sha256:[0-9a-f]{64}", image), "invalid published image")
    return image


def validate_environment(environment, policies):
    require(environment.get("name") == "Production", "Production environment name must match OIDC Subject")
    require(environment.get("can_admins_bypass") is False, "disable administrator bypass of deployment protection")
    require(any(rule.get("type") == "required_reviewers" and rule.get("reviewers")
                for rule in environment.get("protection_rules", [])), "a required deployment reviewer is missing")
    require((environment.get("deployment_branch_policy") or {}).get("custom_branch_policies") is True,
            "configure a custom deployment branch restriction")
    rules = policies.get("branch_policies", [])
    require(len(rules) == 1 and rules[0].get("name") == "master" and rules[0].get("type") == "branch",
            "Production must allow only the master branch")


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", "repos/" + REPO + "/" + path], text=True))


def preflight():
    run_id = os.environ["BUILD_RUN_ID"]
    require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "build_run_id must be a numeric Actions run ID")
    run = api("actions/runs/" + run_id)
    validate_run(run)
    comparison = api("compare/" + run["head_sha"] + "...master")
    require(comparison.get("status") in {"ahead", "identical"}, "candidate is not on master history")
    validate_environment(api("environments/Production"), api("environments/Production/deployment-branch-policies"))
    artifact = "investment-container-published-" + run_id + "-" + str(run["run_attempt"])
    with tempfile.TemporaryDirectory(prefix="deployment-candidate-") as directory:
        subprocess.run(["gh", "run", "download", run_id, "--repo", REPO, "--name", artifact,
                        "--dir", directory], check=True)
        manifest = json.loads((Path(directory) / "published-image.json").read_text())
    image = validate_manifest(manifest, run)
    # Registry access uses no login; a private package fails before production access.
    inspected = json.loads(subprocess.check_output(["docker", "buildx", "imagetools", "inspect", image,
                                                   "--raw"], text=True))
    require(inspected.get("config", {}).get("digest") == manifest["image_id"],
            "registry manifest differs from the smoke-tested image config")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, value in {"image": image, "sha": run["head_sha"], "run_id": run_id}.items():
            output.write(key + "=" + value + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("## 待批准的生产候选\n\n")
        summary.write("- 镜像：`" + image + "`\n- SHA：`" + run["head_sha"] + "`\n")
        summary.write("- 构建：https://github.com/" + REPO + "/actions/runs/" + run_id + "\n")
        summary.write("- 目标：aly / investment；批准后停服、整卷备份、更新并检查健康。\n")


def publication():
    sha = os.environ["GITHUB_SHA"]
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "invalid source SHA")
    reference = os.environ["PUBLISHED_TAG"]
    result = json.loads(subprocess.check_output(["docker", "image", "inspect", reference], text=True))[0]
    expected = Path("candidate/investment-container.image-id").read_text().strip()
    require(result["Id"] == expected, "published config is not the tested config")
    require(result["Config"]["Labels"]["org.opencontainers.image.revision"] == sha, "revision mismatch")
    digests = [item for item in result.get("RepoDigests", []) if item.startswith(IMAGE_REPO + "@sha256:")]
    require(len(digests) == 1, "expected one GHCR digest")
    manifest = {"repository": REPO, "run_id": int(os.environ["GITHUB_RUN_ID"]),
                "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]), "sha": sha,
                "image_id": expected, "image": digests[0]}
    Path("published-image.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("## 已发布镜像\n\n`" + digests[0] + "`\n\n")
        summary.write("生产部署使用本次 run ID：`" + str(manifest["run_id"]) + "`。\n")


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in {"preflight", "publication"}, "invalid command")
        {"preflight": preflight, "publication": publication}[sys.argv[1]]()
    except (CandidateError, KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print("Deployment candidate rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
