"""Owned hosted-job fixture preparation and strict P2 evidence verification.

Source approval/manifest generation is never runtime authorization. Publication
must separately authorize this exact job's operations/resources. Native effects
require explicit hosted execution identity, private config, and recorded ownership.
"""
import copy
import datetime
import secrets
import uuid
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads(Path(__file__).with_name("p2-acceptance-cases.json").read_text())
HEX = r"[a-f0-9]{64}"
DIGEST = r"sha256:" + HEX
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
REFERENCE = r"127\.0\.0\.1:49172/deploylite-p2/[a-z0-9/-]+@" + DIGEST


class PhysicalError(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise PhysicalError(reason)


def validate_context(grant, env, now_ms):
    require(isinstance(grant, dict), "invalid_grant")
    require(env.get("DEPLOYLITE_DOCKER_RUNTIME_GRANT") == grant.get("authorization") == "P2_PHYSICAL_DOCKER_APPROVED", "explicit_runtime_scope_required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted", "hosted_job_required")
    require(grant.get("engineScope") == "ephemeral-github-actions-job", "owned_engine_scope_required")
    job = grant.get("ciJob", {})
    for field, variable in {"repository": "GITHUB_REPOSITORY", "runId": "GITHUB_RUN_ID", "runAttempt": "GITHUB_RUN_ATTEMPT", "job": "GITHUB_JOB"}.items():
        require(isinstance(job.get(field), str) and bool(job[field]) and job[field] == env.get(variable), "job_identity_mismatch")
    require(job.get("job") == "p2-docker-acceptance", "wrong_job")
    require(grant.get("commit") == env.get("GITHUB_SHA") and re.fullmatch(r"[a-f0-9]{40}", grant.get("commit", "")), "commit_identity_mismatch")
    require(isinstance(grant.get("expiresAtMs"), (int, float)) and now_ms < grant["expiresAtMs"] <= now_ms + 7200000, "grant_expired")
    require(re.fullmatch(UUID, grant.get("runId", "")) and len(grant.get("grantId", "")) >= 16, "fresh_execution_identity_required")
    require(grant.get("engineOs") == "linux" and grant.get("engineArchitecture") in ("x86_64", "amd64") and grant.get("platform") == "linux/amd64", "native_platform_required")
    require(isinstance(grant.get("engineId"), str) and len(grant["engineId"]) >= 16, "engine_identity_required")
    require(re.fullmatch(r"unix:///[A-Za-z0-9/_.-]+", grant.get("dockerHost", "")) and grant["dockerHost"] == env.get("DOCKER_HOST"), "socket_identity_mismatch")
    require(not any(env.get(field) for field in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "ambient_context_forbidden")
    require(Path(grant.get("dockerConfigDirectory", "")).is_absolute() and grant["dockerConfigDirectory"] == env.get("DOCKER_CONFIG"), "private_config_binding_required")
    require(grant.get("bounds") == MANIFEST["resourceProposal"], "resource_scope_mismatch")
    require(set(grant.get("sourceHashes", {})) == set(MANIFEST["sourceFiles"]) and all(re.fullmatch(HEX, value) for value in grant["sourceHashes"].values()), "source_scope_mismatch")
    return copy.deepcopy(grant)


def validate_config(metadata, entries):
    require(metadata.get("directory") is True and metadata.get("symlink") is False and metadata.get("owned") is True and metadata.get("mode", 0) & 0o077 == 0, "private_owned_directory_required")
    require(entries == [], "empty_config_required")


def validate_sources(expected, current):
    return bool(expected) and expected == current and set(expected) == set(MANIFEST["sourceFiles"])


def manifest_reference(body, header, repository):
    require(isinstance(body, bytes) and header == "sha256:" + hashlib.sha256(body).hexdigest(), "observed_manifest_digest_mismatch")
    require(re.fullmatch(r"127\.0\.0\.1:49172/deploylite-p2/[a-z0-9/-]+", repository), "owned_repository_required")
    data = json.loads(body)
    require(data.get("schemaVersion") == 2, "unsupported_manifest")
    return repository + "@" + header


def validate_image(info, expected):
    require(re.fullmatch(DIGEST, info.get("id", "")), "image_config_identity_required")
    require(expected["reference"] in info.get("repoDigests", []) and re.fullmatch(REFERENCE, expected["reference"]), "observed_repo_digest_required")
    require(info.get("platform") == expected["platform"] == "linux/amd64" and info.get("user") == "65532:65532", "image_platform_or_user_mismatch")
    require(info.get("command") == ["/bin/busybox", "httpd", "-f", "-p", "8080", "-h", "/www"], "fixture_command_mismatch")
    require(info.get("healthIntervalNs") == info.get("healthTimeoutNs") == 1000000000 and info.get("healthPath") == "/healthz", "fixture_health_mismatch")
    require(info.get("flavor") == expected["flavor"] in ("a", "h"), "fixture_flavor_mismatch")
    return copy.deepcopy(info)
