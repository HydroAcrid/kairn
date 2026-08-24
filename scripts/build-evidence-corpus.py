#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Validate and flatten a sealed Kairn evidence-ranker corpus manifest."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


FEATURES = [
    "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25",
    "keyword", "semantic", "failureReference", "gitChanged",
    "alreadyDelivered", "graphNeighbor", "graphPrecision", "graphConsensus",
    "graphSupport", "graphSeedStrength", "graphIndependentEvidence", "sourceTestPair",
    "productionSource", "testFile", "docsFile", "generatedVendor",
    "intentRoleMatch", "importance", "contentCost", "missingSymbols",
    "missingLexical",
]
FEATURE_SCHEMA_VERSION = "evidence-features-v4"
LANGUAGES = ("python", "typescript", "go", "java", "cpp")
SCENARIOS = ("source_localization", "failure_first", "long_session")
SPLITS = ("train", "calibration", "holdout")
LINEAGE_ROLES = {"train", "calibration", "holdout", "live_smoke", "pilot", "retired"}
SPLIT_ROLES = {"train": "train", "calibration": "calibration", "holdout": "holdout"}
LABEL_POLICIES: dict[str, tuple[int, float]] = {
    "required_source_oracle": (1, 1.0),
    "explicit_noise_or_excluded": (0, 1.0),
    "verified_official_patch_source": (1, 0.75),
    "quality_passing_observed_read_touch": (1, 0.25),
}
DATA_ORIGINS = {"public_benchmark", "public_patch", "synthetic"}
PRODUCTION_COUNTS = {
    "train": {"cases": 90, "lineages": 20, "perLanguage": 18, "perCell": 6},
    "calibration": {"cases": 45, "lineages": 10, "perLanguage": 9, "perCell": 3},
    "holdout": {"cases": 30, "lineages": 10, "perLanguage": 6, "perCell": 2},
}


def require_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def require_https(value: Any, label: str) -> str:
    candidate = require_string(value, label)
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError(f"{label} must be a credential-free absolute HTTPS URL")
    return candidate


def canonical_repository_url(value: Any, label: str, *, allow_synthetic: bool) -> str:
    candidate = require_string(value, label)
    if allow_synthetic and candidate.startswith(("synthetic:", "synthetic-")):
        return candidate
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError(f"{label} must be a canonical public HTTPS repository URL")
    if parsed.query or parsed.fragment or parsed.params:
        raise ValueError(f"{label} must not contain a query, fragment, or parameters")
    return candidate.rstrip("/")


def load_registry(target: Path, *, allow_sample: bool) -> dict[str, dict[str, Any]]:
    root = require_record(json.loads(target.read_text(encoding="utf-8")), "lineage registry")
    if root.get("schemaVersion") != "lineage-registry.v1":
        raise ValueError("lineage registry schemaVersion must be lineage-registry.v1")
    rows = root.get("lineages")
    if not isinstance(rows, list):
        raise ValueError("lineage registry lineages must be an array")
    registry: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(rows):
        row = require_record(value, f"lineages[{index}]")
        lineage_id = canonical_repository_url(
            row.get("id"), f"lineages[{index}].id", allow_synthetic=allow_sample
        )
        role = require_string(row.get("role"), f"lineages[{index}].role")
        if role not in LINEAGE_ROLES:
            raise ValueError(f"lineages[{index}].role must be one of {sorted(LINEAGE_ROLES)}")
        if lineage_id in registry:
            raise ValueError(f"duplicate lineage id: {lineage_id}")
        if role == "retired" and not require_string(row.get("retiredReason"), f"lineages[{index}].retiredReason"):
            raise ValueError(f"lineages[{index}] retired lineages require retiredReason")
        registry[lineage_id] = {**row, "id": lineage_id, "role": role}
    return registry


def validate_features(value: Any, label: str) -> list[float]:
    record = require_record(value, label)
    missing = [feature for feature in FEATURES if feature not in record]
    extra = sorted(set(record).difference(FEATURES))
    if missing or extra:
        raise ValueError(f"{label} feature keys mismatch; missing={missing}, extra={extra}")
    ordered: list[float] = []
    for feature in FEATURES:
        item = record[feature]
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError(f"{label}.{feature} must be a finite number")
        if item < 0 or item > 1:
            raise ValueError(f"{label}.{feature} must be normalized to [0,1]")
        ordered.append(float(item))
    return ordered


def validate_candidate(value: Any, label: str) -> dict[str, Any]:
    row = require_record(value, label)
    candidate_path = require_string(row.get("path"), f"{label}.path").replace("\\", "/")
    if candidate_path.startswith("/") or candidate_path.startswith("../") or "/../" in candidate_path:
        raise ValueError(f"{label}.path must be repository-relative")
    provenance = row.get("labelProvenance")
    raw_label = row.get("label")
    raw_weight = row.get("labelWeight")
    if raw_label is None:
        if provenance is not None or raw_weight is not None:
            raise ValueError(f"{label}: unlabeled candidates must omit labelProvenance and labelWeight")
        normalized_label = None
        normalized_weight = None
    else:
        if isinstance(raw_label, bool) or raw_label not in (0, 1):
            raise ValueError(f"{label}.label must be 0, 1, or null")
        policy = LABEL_POLICIES.get(provenance) if isinstance(provenance, str) else None
        if policy is None or (raw_label, raw_weight) != policy:
            raise ValueError(f"{label}: labelProvenance must use its fixed label and weight")
        normalized_label = int(raw_label)
        normalized_weight = float(raw_weight)
    return {
        "path": candidate_path,
        "features": validate_features(row.get("features"), f"{label}.features"),
        "label": normalized_label,
        "labelWeight": normalized_weight,
        "labelProvenance": provenance,
    }


def validate_case(
    value: Any,
    index: int,
    registry: dict[str, dict[str, Any]],
    *,
    allow_sample: bool,
) -> dict[str, Any]:
    label = f"cases[{index}]"
    row = require_record(value, label)
    case_id = require_string(row.get("id"), f"{label}.id")
    split = require_string(row.get("split"), f"{label}.split")
    language = require_string(row.get("language"), f"{label}.language")
    scenario = require_string(row.get("scenario"), f"{label}.scenario")
    if split not in SPLITS:
        raise ValueError(f"{label}.split must be train, calibration, or holdout")
    if language not in LANGUAGES:
        raise ValueError(f"{label}.language is unsupported")
    if scenario not in SCENARIOS:
        raise ValueError(f"{label}.scenario is unsupported")
    lineage_id = canonical_repository_url(
        row.get("repositoryLineageId"), f"{label}.repositoryLineageId", allow_synthetic=allow_sample
    )
    lineage = registry.get(lineage_id)
    if lineage is None:
        raise ValueError(f"{label}: lineage {lineage_id} is absent from the registry")
    if lineage["role"] != SPLIT_ROLES[split]:
        raise ValueError(f"{label}: lineage role {lineage['role']} does not match split {split}")
    origin = require_string(row.get("dataOrigin"), f"{label}.dataOrigin")
    if origin not in DATA_ORIGINS:
        raise ValueError(f"{label}.dataOrigin is unsupported")
    public_source = require_https(row.get("publicSourceUrl"), f"{label}.publicSourceUrl")
    repository_url = row.get("repositoryUrl")
    repository_ref = row.get("repositoryRef")
    query = row.get("prompt")
    query_digest = row.get("querySha256")
    if not allow_sample:
        canonical_url = canonical_repository_url(
            repository_url, f"{label}.repositoryUrl", allow_synthetic=False
        )
        if canonical_url.removesuffix(".git") != lineage_id.removesuffix(".git"):
            raise ValueError(f"{label}: repositoryUrl must match repositoryLineageId")
        pinned_ref = require_string(repository_ref, f"{label}.repositoryRef")
        if len(pinned_ref) not in (40, 64) or any(char not in "0123456789abcdefABCDEF" for char in pinned_ref):
            raise ValueError(f"{label}.repositoryRef must be a full immutable commit hash")
        prompt = require_string(query, f"{label}.prompt")
        expected_query_digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        if query_digest != expected_query_digest:
            raise ValueError(f"{label}.querySha256 does not match prompt")
    synthetic_parent = row.get("syntheticVariantOf")
    synthetic_index = row.get("syntheticVariantIndex")
    if origin == "synthetic":
        if split != "train":
            raise ValueError(f"{label}: synthetic variants are allowed only in train")
        require_string(synthetic_parent, f"{label}.syntheticVariantOf")
        if isinstance(synthetic_index, bool) or synthetic_index not in (1, 2):
            raise ValueError(f"{label}.syntheticVariantIndex must be 1 or 2")
    elif synthetic_parent is not None or synthetic_index is not None:
        raise ValueError(f"{label}: natural cases must omit synthetic variant fields")
    candidates_value = row.get("candidates")
    if not isinstance(candidates_value, list):
        raise ValueError(f"{label}.candidates must be an array")
    if not 7 <= len(candidates_value) <= 64:
        raise ValueError(f"{label}.candidates must contain 7 to 64 bounded candidates")
    serving_candidates = [
        validate_candidate(item, f"{label}.candidates[{candidate_index}]")
        for candidate_index, item in enumerate(candidates_value)
    ]
    serving_paths = [candidate["path"] for candidate in serving_candidates]
    if len(serving_paths) != len(set(serving_paths)):
        raise ValueError(f"{label}.candidates contains duplicate paths")
    training_candidates_value = row.get("trainingCandidates", candidates_value)
    if not isinstance(training_candidates_value, list):
        raise ValueError(f"{label}.trainingCandidates must be an array")
    if not 7 <= len(training_candidates_value) <= 128:
        raise ValueError(f"{label}.trainingCandidates must contain 7 to 128 bounded candidates")
    training_candidates = [
        validate_candidate(item, f"{label}.trainingCandidates[{candidate_index}]")
        for candidate_index, item in enumerate(training_candidates_value)
    ]
    training_paths = [candidate["path"] for candidate in training_candidates]
    if len(training_paths) != len(set(training_paths)):
        raise ValueError(f"{label}.trainingCandidates contains duplicate paths")
    if training_paths[:len(serving_paths)] != serving_paths:
        raise ValueError(f"{label}.trainingCandidates must preserve the ordered candidate@64 prefix")
    required_source_oracle_count = row.get("requiredSourceOracleCount", 0)
    required_source_oracle_sha256 = row.get("requiredSourceOracleSha256")
    required_source_existing_count = row.get("requiredSourceExistingCount", required_source_oracle_count)
    required_source_existing_sha256 = row.get("requiredSourceExistingSha256", required_source_oracle_sha256)
    required_source_creation_count = row.get("requiredSourceCreationCount", 0)
    required_source_creation_sha256 = row.get("requiredSourceCreationSha256", hashlib.sha256(b"").hexdigest())
    if not allow_sample:
        for field, value in (
            ("requiredSourceOracleCount", required_source_oracle_count),
            ("requiredSourceExistingCount", required_source_existing_count),
            ("requiredSourceCreationCount", required_source_creation_count),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{label}.{field} must be an integer")
            if value < 0:
                raise ValueError(f"{label}.{field} must not be negative")
        if required_source_existing_count + required_source_creation_count != required_source_oracle_count:
            raise ValueError(f"{label}: existing and creation source counts must partition the required-source oracle")
        for field, value in (
            ("requiredSourceOracleSha256", required_source_oracle_sha256),
            ("requiredSourceExistingSha256", required_source_existing_sha256),
            ("requiredSourceCreationSha256", required_source_creation_sha256),
        ):
            digest = require_string(value, f"{label}.{field}")
            if len(digest) != 64 or any(char not in "0123456789abcdefABCDEF" for char in digest):
                raise ValueError(f"{label}.{field} must be a SHA-256 digest")
        if split == "holdout" and required_source_oracle_count < 1:
            raise ValueError(f"{label}: production holdout cases require an independently reviewed source oracle")
    explicit_negatives = sum(
        candidate["labelProvenance"] == "explicit_noise_or_excluded" for candidate in training_candidates
    )
    if explicit_negatives < 6:
        raise ValueError(f"{label} requires at least six explicit noise/excluded negatives")
    return {
        "id": case_id,
        "split": split,
        "language": language,
        "scenario": scenario,
        "repositoryLineageId": lineage_id,
        "publicSourceUrl": public_source,
        "repositoryUrl": repository_url,
        "repositoryRef": repository_ref,
        "prompt": query,
        "querySha256": query_digest,
        "dataOrigin": origin,
        "syntheticVariantOf": synthetic_parent,
        "syntheticVariantIndex": synthetic_index,
        "requiredSourceOracleCount": required_source_oracle_count,
        "requiredSourceOracleSha256": required_source_oracle_sha256,
        "requiredSourceExistingCount": required_source_existing_count,
        "requiredSourceExistingSha256": required_source_existing_sha256,
        "requiredSourceCreationCount": required_source_creation_count,
        "requiredSourceCreationSha256": required_source_creation_sha256,
        "servingCandidates": serving_candidates,
        "candidates": training_candidates,
    }


def validate_distribution(cases: list[dict[str, Any]], *, sample_only: bool) -> None:
    if sample_only:
        return
    natural_cases = [case for case in cases if case["dataOrigin"] != "synthetic"]
    for split, expected in PRODUCTION_COUNTS.items():
        split_cases = [case for case in natural_cases if case["split"] == split]
        if len(split_cases) != expected["cases"]:
            raise ValueError(f"{split} must contain exactly {expected['cases']} cases")
        lineage_count = len({case["repositoryLineageId"] for case in split_cases})
        if lineage_count != expected["lineages"]:
            raise ValueError(f"{split} must contain exactly {expected['lineages']} repository lineages")
        for language in LANGUAGES:
            language_cases = [case for case in split_cases if case["language"] == language]
            if len(language_cases) != expected["perLanguage"]:
                raise ValueError(f"{split}/{language} must contain exactly {expected['perLanguage']} cases")
            for scenario in SCENARIOS:
                count = sum(case["scenario"] == scenario for case in language_cases)
                if count != expected["perCell"]:
                    raise ValueError(f"{split}/{language}/{scenario} must contain exactly {expected['perCell']} cases")


def validate_synthetic_variants(cases: list[dict[str, Any]]) -> None:
    by_id = {case["id"]: case for case in cases}
    variants: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        parent_id = case.get("syntheticVariantOf")
        if not parent_id:
            continue
        parent = by_id.get(parent_id)
        if parent is None:
            raise ValueError(f"{case['id']}: synthetic parent {parent_id} does not exist")
        if parent["dataOrigin"] == "synthetic" or parent["split"] != "train":
            raise ValueError(f"{case['id']}: synthetic parent must be a natural train case")
        for field in ("language", "scenario", "repositoryLineageId"):
            if case[field] != parent[field]:
                raise ValueError(f"{case['id']}: synthetic variant must preserve parent {field}")
        variants[parent_id].append(case)
    for parent_id, rows in variants.items():
        indexes = [row["syntheticVariantIndex"] for row in rows]
        if len(rows) > 2 or len(set(indexes)) != len(indexes):
            raise ValueError(f"{parent_id}: at most two deterministic synthetic variants are allowed")


def flatten(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for case in sorted(cases, key=lambda item: item["id"]):
        for candidate in sorted(case["candidates"], key=lambda item: item["path"]):
            row = {
                "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                "repositoryLineageId": case["repositoryLineageId"],
                "caseGroupId": case["id"],
                "split": case["split"],
                "language": case["language"],
                "scenario": case["scenario"],
                "candidatePath": candidate["path"],
                "isPublic": True,
                "publicSourceUrl": case["publicSourceUrl"],
                "dataOrigin": case["dataOrigin"],
                "label": candidate["label"],
                "features": candidate["features"],
            }
            if candidate["label"] is not None:
                row["labelWeight"] = candidate["labelWeight"]
                row["labelProvenance"] = candidate["labelProvenance"]
            if case.get("syntheticVariantOf"):
                row["syntheticVariantOf"] = case["syntheticVariantOf"]
                row["syntheticVariantIndex"] = case["syntheticVariantIndex"]
            rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=Path("artifacts/ranker-corpus.jsonl"))
    parser.add_argument("--summary-out", type=Path, default=Path("artifacts/ranker-corpus.summary.json"))
    parser.add_argument("--allow-sample", action="store_true")
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    root = require_record(json.loads(manifest_path.read_text(encoding="utf-8")), "corpus manifest")
    if root.get("schemaVersion") != "ranker-corpus.v1":
        raise ValueError("schemaVersion must be ranker-corpus.v1")
    corpus_id = require_string(root.get("corpusId"), "corpusId")
    if root.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION:
        raise ValueError(f"featureSchemaVersion must be {FEATURE_SCHEMA_VERSION}")
    if root.get("sealed") is not True:
        raise ValueError("corpus manifest must be sealed before construction")
    sample_only = root.get("sampleOnly")
    if not isinstance(sample_only, bool):
        raise ValueError("sampleOnly must be a boolean")
    if sample_only and not args.allow_sample:
        raise ValueError("sample-only corpus requires --allow-sample")
    if not sample_only:
        materializer = require_record(root.get("materializer"), "materializer")
        if materializer.get("schemaVersion") != "ranker-corpus-materializer.v1":
            raise ValueError("materializer.schemaVersion must be ranker-corpus-materializer.v1")
        for field in ("kairnCommit", "intakeSha256"):
            value = require_string(materializer.get(field), f"materializer.{field}")
            expected_lengths = (40, 64) if field == "kairnCommit" else (64,)
            if len(value) not in expected_lengths or any(char not in "0123456789abcdefABCDEF" for char in value):
                raise ValueError(f"materializer.{field} must be a hexadecimal provenance hash")
        if (
            materializer.get("candidateLimit") != 64
            or materializer.get("enrichedCandidateLimit", 128) != 128
            or materializer.get("graphHops") != 1
        ):
            raise ValueError(
                "materializer must pin candidateLimit=64, enrichedCandidateLimit=128, and graphHops=1"
            )
        if materializer.get("caseProcessIsolation") is not True:
            raise ValueError("materializer must prove caseProcessIsolation=true")
    registry_ref = require_string(root.get("lineageRegistry"), "lineageRegistry")
    registry_path = (manifest_path.parent / registry_ref).resolve()
    registry = load_registry(registry_path, allow_sample=sample_only)
    values = root.get("cases")
    if not isinstance(values, list) or not values:
        raise ValueError("cases must be a non-empty array")
    cases = [validate_case(value, index, registry, allow_sample=sample_only) for index, value in enumerate(values)]
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("case ids must be unique")
    validate_synthetic_variants(cases)
    validate_distribution(cases, sample_only=sample_only)

    used_lineages = {case["repositoryLineageId"] for case in cases}
    active_corpus_lineages = {
        lineage_id for lineage_id, row in registry.items() if row["role"] in set(SPLIT_ROLES.values())
    }
    if not sample_only and used_lineages != active_corpus_lineages:
        missing = sorted(active_corpus_lineages.difference(used_lineages))
        extra = sorted(used_lineages.difference(active_corpus_lineages))
        raise ValueError(f"corpus/registry lineage mismatch; unused={missing}, unregistered={extra}")

    rows = flatten(cases)
    zero_positive_cases = sum(
        not any(candidate["label"] == 1 for candidate in case["candidates"])
        for case in cases
    )
    required_source_creation_cases = sum(case["requiredSourceCreationCount"] > 0 for case in cases)
    required_source_creation_files = sum(case["requiredSourceCreationCount"] for case in cases)
    rendered = "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in rows)
    digest = hashlib.sha256(rendered.encode("utf-8")).hexdigest()
    summary = {
        "schemaVersion": "ranker-corpus-summary.v1",
        "corpusId": corpus_id,
        "sampleOnly": sample_only,
        "sealed": True,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "corpusSha256": digest,
        "caseCount": len(cases),
        "naturalCaseCount": sum(case["dataOrigin"] != "synthetic" for case in cases),
        "syntheticVariantCases": sum(case["dataOrigin"] == "synthetic" for case in cases),
        "candidateRows": len(rows),
        "labeledRows": sum(row["label"] is not None for row in rows),
        "unlabeledRows": sum(row["label"] is None for row in rows),
        "zeroPositiveCases": zero_positive_cases,
        "requiredSourceCreationCases": required_source_creation_cases,
        "requiredSourceCreationFiles": required_source_creation_files,
        "splits": {
            split: {
                "cases": sum(case["split"] == split for case in cases),
                "repositoryLineages": len({case["repositoryLineageId"] for case in cases if case["split"] == split}),
                "languages": dict(sorted(Counter(case["language"] for case in cases if case["split"] == split).items())),
                "scenarios": dict(sorted(Counter(case["scenario"] for case in cases if case["split"] == split).items())),
                "zeroPositiveCases": sum(
                    case["split"] == split
                    and not any(candidate["label"] == 1 for candidate in case["candidates"])
                    for case in cases
                ),
                "requiredSourceCreationCases": sum(
                    case["split"] == split and case["requiredSourceCreationCount"] > 0
                    for case in cases
                ),
                "requiredSourceCreationFiles": sum(
                    case["requiredSourceCreationCount"]
                    for case in cases
                    if case["split"] == split
                ),
            }
            for split in SPLITS
        },
        "lineageRegistrySha256": hashlib.sha256(registry_path.read_bytes()).hexdigest(),
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }
    output = args.out.resolve()
    summary_output = args.summary_out.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    summary_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    summary_output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"corpus": str(output), "summary": str(summary_output), **summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
