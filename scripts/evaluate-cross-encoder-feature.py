#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Evaluate one learned query/file feature on the frozen v185 ranking pools."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
from typing import Any


CROSS_ENCODER_FEATURES = ["crossEncoderProbability", "missingCrossEncoder"]


def load_semantic_evaluator() -> Any:
    target = Path(__file__).resolve().with_name("evaluate-semantic-document-features.py")
    spec = importlib.util.spec_from_file_location("kairn_semantic_evaluator", target)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load semantic document evaluator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SEMANTIC = load_semantic_evaluator()
BASE_FEATURES = SEMANTIC.BASE_FEATURES
DOCUMENT_FEATURES = SEMANTIC.DOCUMENT_FEATURES
FEATURES = BASE_FEATURES + DOCUMENT_FEATURES + CROSS_ENCODER_FEATURES


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical_sha256(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf8")
    return sha256(raw)


def load_trainer() -> Any:
    SEMANTIC.FEATURES = FEATURES
    trainer = SEMANTIC.load_trainer()
    trainer.FEATURES = FEATURES
    return trainer


def cross_encoder_features(score: dict[str, Any] | None) -> list[float]:
    if score is None:
        return [0.0, 1.0]
    probability = score.get("probability")
    if not isinstance(probability, (int, float)) or not math.isfinite(probability):
        raise ValueError("cross-encoder probability must be finite")
    if probability < 0 or probability > 1:
        raise ValueError("cross-encoder probability must be normalized")
    return [float(probability), 0.0]


def score_maps(
    artifact: dict[str, Any],
    manifest: dict[str, Any],
    manifest_sha: str,
    report_sha: str,
    training_sha: str,
) -> dict[str, dict[str, dict[str, Any]]]:
    if artifact.get("schemaVersion") != "cross-encoder-frozen-pool-scores.v2":
        raise ValueError("cross-encoder score schema mismatch")
    if artifact.get("promotionEligible") is not False or artifact.get("nonEvidence") is not False:
        raise ValueError("cross-encoder scores must be a completed non-promotion diagnostic")
    cohort = artifact.get("cohort")
    if not isinstance(cohort, dict) or cohort.get("holdoutAccessed") is not False:
        raise ValueError("cross-encoder score artifact must keep detached holdout sealed")
    inputs = artifact.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError("cross-encoder score inputs are missing")
    expected = {
        "manifestSha256": manifest_sha,
        "reportSha256": report_sha,
        "trainingRowsSha256": training_sha,
    }
    for key, value in expected.items():
        if inputs.get(key) != value:
            raise ValueError(f"cross-encoder {key} does not match the frozen input")

    manifest_cases = {str(case["id"]): case for case in manifest["cases"]}
    score_cases = artifact.get("cases")
    if not isinstance(score_cases, list) or len(score_cases) != 135:
        raise ValueError("cross-encoder artifact must contain all 135 cases")
    if {str(case.get("id")) for case in score_cases} != set(manifest_cases):
        raise ValueError("cross-encoder and manifest case populations differ")

    output: dict[str, dict[str, dict[str, Any]]] = {}
    for score_case in score_cases:
        case_id = str(score_case["id"])
        manifest_case = manifest_cases[case_id]
        if score_case.get("querySha256") != manifest_case.get("querySha256"):
            raise ValueError(f"{case_id}: cross-encoder query hash changed")
        requires_complete_pool = (
            manifest_case.get("split") == "calibration"
            or int(manifest_case.get("requiredSourceExistingCount", 0)) > 0
        )
        if requires_complete_pool and score_case.get("allPoolScoresAvailable") is not True:
            raise ValueError(f"{case_id}: cross-encoder evaluation pool scoring is incomplete")
        candidates = score_case.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError(f"{case_id}: cross-encoder candidates are missing")
        by_path: dict[str, dict[str, Any]] = {}
        for candidate in candidates:
            candidate_path = str(candidate.get("path", ""))
            if not candidate_path or candidate_path in by_path:
                raise ValueError(f"{case_id}: invalid or duplicate cross-encoder path")
            cross_encoder_features(candidate)
            by_path[candidate_path] = candidate
        frozen_paths = [str(row["path"]) for row in manifest_case["trainingCandidates"]]
        scored_frozen = [
            str(candidate["path"])
            for candidate in candidates
            if candidate.get("inFrozenPool") is True
        ]
        if requires_complete_pool and scored_frozen != frozen_paths:
            raise ValueError(f"{case_id}: cross-encoder frozen pool changed")
        if any(candidate_path not in frozen_paths for candidate_path in scored_frozen):
            raise ValueError(f"{case_id}: cross-encoder marked an unknown path as frozen")
        output[case_id] = by_path
    return output


def interaction_maps(report: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    return SEMANTIC.interaction_maps(report)


def read_rows(
    target: Path,
    interactions: dict[str, dict[str, dict[str, Any]]],
    scores: dict[str, dict[str, dict[str, Any]]],
) -> tuple[list[dict[str, Any]], bytes]:
    raw = target.read_bytes()
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("label") not in (0, 1):
            continue
        if row.get("featureSchemaVersion") != "evidence-features-v4":
            raise ValueError(f"line {line_number}: expected evidence-features-v4")
        base = row.get("features")
        if not isinstance(base, list) or len(base) != len(BASE_FEATURES):
            raise ValueError(f"line {line_number}: invalid base feature vector")
        case_id = str(row.get("caseGroupId", ""))
        candidate_path = str(row.get("candidatePath", ""))
        case_interactions = interactions.get(case_id)
        case_scores = scores.get(case_id)
        if case_interactions is None or case_scores is None:
            raise ValueError(f"line {line_number}: missing diagnostic case {case_id}")
        score = case_scores.get(candidate_path)
        if score is None:
            raise ValueError(f"line {line_number}: missing cross-encoder score for {case_id}:{candidate_path}")
        rows.append({
            **row,
            "featureSchemaVersion": "evidence-features-v6-cross-encoder-diagnostic",
            "features": (
                [float(value) for value in base]
                + SEMANTIC.document_features(case_interactions.get(candidate_path))
                + cross_encoder_features(score)
            ),
            "labelWeight": float(row["labelWeight"]),
        })
    return rows, raw


def summarize_case_rows(case_rows: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in case_rows:
        groups.setdefault((str(row["language"]), str(row["scenario"])), []).append(row)
    output: dict[str, Any] = {}
    for (language, scenario), rows in sorted(groups.items()):
        ranks = [rank for row in rows for rank in row["ranks"].values()]
        output[f"{language}/{scenario}"] = {
            "cases": len(rows),
            "requiredFiles": len(ranks),
            "recallAt5": sum(rank is not None and rank <= 5 for rank in ranks) / len(ranks),
            "recallAt64": sum(rank is not None and rank <= 64 for rank in ranks) / len(ranks),
            "mrr": sum(0 if rank is None else 1 / rank for rank in ranks) / len(ranks),
        }
    return output


def evaluate_cases(
    cases: list[dict[str, Any]],
    reports: dict[str, dict[str, Any]],
    interactions: dict[str, dict[str, dict[str, Any]]],
    scores: dict[str, dict[str, dict[str, Any]]],
    trainer: Any,
    intercept: float,
    coefficients: list[float],
    reference: str,
) -> dict[str, Any]:
    failure_index = FEATURES.index("failureReference")
    exact_path_index = FEATURES.index("exactPath")
    generated_index = FEATURES.index("generatedVendor")
    results: list[dict[str, Any]] = []
    for case in cases:
        case_id = str(case["id"])
        required = reports[case_id][reference]
        if not required:
            continue
        ranked: list[dict[str, Any]] = []
        for candidate in case["trainingCandidates"]:
            candidate_path = str(candidate["path"])
            score = scores[case_id].get(candidate_path)
            if score is None:
                raise ValueError(f"{case_id}:{candidate_path}: missing frozen-pool score")
            base = [float(candidate["features"][name]) for name in BASE_FEATURES]
            features = (
                base
                + SEMANTIC.document_features(interactions[case_id].get(candidate_path))
                + cross_encoder_features(score)
            )
            priority = 2 if features[failure_index] > 0 else 1 if features[exact_path_index] > 0 else 0
            ranked.append({
                "path": candidate_path,
                "priority": priority,
                "score": trainer.raw_score(intercept, coefficients, features),
                "generatedVendor": features[generated_index] > 0,
            })
        ranked.sort(key=lambda item: (-item["priority"], -item["score"], item["path"]))
        positions = {item["path"]: index + 1 for index, item in enumerate(ranked)}
        results.append({
            "id": case_id,
            "language": case["language"],
            "scenario": case["scenario"],
            "ranks": {path: positions.get(path) for path in required},
            "generatedVendorTopOne": bool(ranked and ranked[0]["generatedVendor"]),
        })
    ranks = [rank for item in results for rank in item["ranks"].values()]
    if not ranks:
        raise ValueError(f"no required files found for {reference}")
    recall = lambda limit: sum(rank is not None and rank <= limit for rank in ranks) / len(ranks)
    misses = lambda limit: [
        {"id": item["id"], "requiredFileRanks": item["ranks"]}
        for item in results
        if not all(rank is not None and rank <= limit for rank in item["ranks"].values())
    ]
    return {
        "cases": len(results),
        "requiredFiles": len(ranks),
        "recallAt1": recall(1),
        "recallAt5": recall(5),
        "recallAt64": recall(64),
        "recallAt128": recall(128),
        "mrr": sum(0 if rank is None else 1 / rank for rank in ranks) / len(ranks),
        "strictFullRecallAt64": sum(
            all(rank is not None and rank <= 64 for rank in item["ranks"].values())
            for item in results
        ) / len(results),
        "strictFullRecallAt128": sum(
            all(rank is not None and rank <= 128 for rank in item["ranks"].values())
            for item in results
        ) / len(results),
        "generatedVendorTopOneViolations": [
            item["id"] for item in results if item["generatedVendorTopOne"]
        ],
        "missesAt5": misses(5),
        "missesAt64": misses(64),
        "strata": summarize_case_rows(results),
        "caseRows": results,
    }


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--":
        argv = argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-rows", required=True)
    parser.add_argument("--candidate-manifest", required=True)
    parser.add_argument("--candidate-report", required=True)
    parser.add_argument("--cross-encoder-scores", required=True)
    parser.add_argument("--baseline-evaluation", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    training_path = Path(args.training_rows).resolve()
    manifest_path = Path(args.candidate_manifest).resolve()
    report_path = Path(args.candidate_report).resolve()
    scores_path = Path(args.cross_encoder_scores).resolve()
    baseline_path = Path(args.baseline_evaluation).resolve()
    raw = {
        "training": training_path.read_bytes(),
        "manifest": manifest_path.read_bytes(),
        "report": report_path.read_bytes(),
        "scores": scores_path.read_bytes(),
        "baseline": baseline_path.read_bytes(),
    }
    manifest = json.loads(raw["manifest"])
    report = json.loads(raw["report"])
    score_artifact = json.loads(raw["scores"])
    baseline = json.loads(raw["baseline"])
    if baseline.get("schemaVersion") != "semantic-document-feature-diagnostic.v1":
        raise ValueError("baseline evaluation schema mismatch")
    if baseline.get("samePoolVerified") is not True or baseline.get("promotionEligible") is not False:
        raise ValueError("baseline must be the frozen same-pool diagnostic")
    baseline_inputs = baseline.get("inputs")
    if not isinstance(baseline_inputs, dict):
        raise ValueError("baseline inputs are missing")
    expected_baseline_inputs = {
        "trainingRowsSha256": sha256(raw["training"]),
        "candidateManifestSha256": sha256(raw["manifest"]),
        "candidateReportSha256": sha256(raw["report"]),
    }
    for key, value in expected_baseline_inputs.items():
        if baseline_inputs.get(key) != value:
            raise ValueError(f"baseline {key} differs from the requested frozen input")
    if manifest.get("materializer", {}).get("intakeSha256") != report.get("intakeSha256"):
        raise ValueError("candidate manifest/report provenance mismatch")
    scores = score_maps(
        score_artifact,
        manifest,
        sha256(raw["manifest"]),
        sha256(raw["report"]),
        sha256(raw["training"]),
    )
    interactions = interaction_maps(report)
    rows, _ = read_rows(training_path, interactions, scores)
    train = [row for row in rows if row["split"] == "train"]
    calibration = [row for row in rows if row["split"] == "calibration"]
    if not train or not calibration:
        raise ValueError("train and calibration rows are required")
    if any(row["split"] == "holdout" for row in rows):
        raise ValueError("detached holdout access is forbidden in this diagnostic")

    trainer = load_trainer()
    selected_l2, cv_scores = trainer.choose_l2_pairwise(train)
    pairs = trainer.build_pairwise_rows(train)
    intercept = 0.0
    coefficients = trainer.train_pairwise_logistic(pairs, selected_l2)
    platt_a, platt_b = trainer.fit_platt(calibration, intercept, coefficients)
    probabilities = trainer.calibrated_probabilities(
        calibration, intercept, coefficients, platt_a, platt_b
    )
    labels = [int(row["label"]) for row in calibration]
    clipped = [max(1e-12, min(1 - 1e-12, probability)) for probability in probabilities]
    reports = {str(item["id"]): item for item in report["cases"]}
    weak_patch = evaluate_cases(
        [case for case in manifest["cases"] if case["split"] == "calibration"],
        reports, interactions, scores, trainer, intercept, coefficients,
        "officialPatchSourceExistingFiles",
    )
    required_source = evaluate_cases(
        manifest["cases"], reports, interactions, scores, trainer, intercept, coefficients,
        "requiredSourceExistingFiles",
    )
    baseline_schema = baseline["featureSchema"]
    output = {
        "schemaVersion": "semantic-document-feature-diagnostic.v1",
        "promotionEligible": False,
        "reason": (
            "Train/calibration-only same-pool learned-feature diagnostic. The detached "
            "holdout remains sealed and this artifact cannot be promoted."
        ),
        "detachedHoldoutOpened": False,
        "samePoolVerified": True,
        "controlledFeatureExperiment": {
            "baselineFeatureSchemaSha256": canonical_sha256(baseline_schema),
            "unchangedFrozenInputs": True,
            "addedFeatures": CROSS_ENCODER_FEATURES,
            "changedMechanism": "one local model-derived query/file relevance probability",
        },
        "inputs": {
            **baseline_inputs,
            "trainingRowsSha256": sha256(raw["training"]),
            "candidateManifestSha256": sha256(raw["manifest"]),
            "candidateReportSha256": sha256(raw["report"]),
            "crossEncoderScoresSha256": sha256(raw["scores"]),
            "baselineEvaluationSha256": sha256(raw["baseline"]),
        },
        "featureSchema": {
            "base": BASE_FEATURES,
            "added": DOCUMENT_FEATURES + CROSS_ENCODER_FEATURES,
        },
        "model": {
            "kind": "pairwise_logistic",
            "trainingPairs": len(pairs),
            "selectedL2": selected_l2,
            "crossValidationLogLoss": cv_scores,
            "intercept": intercept,
            "coefficients": dict(zip(FEATURES, coefficients, strict=True)),
            "calibration": {"kind": "platt", "a": platt_a, "b": platt_b},
        },
        "calibrationEce": trainer.expected_calibration_error(labels, probabilities),
        "calibrationBrier": sum(
            (probability - label) ** 2
            for probability, label in zip(probabilities, labels, strict=True)
        ) / len(labels),
        "calibrationLogLoss": -sum(
            label * math.log(probability) + (1 - label) * math.log(1 - probability)
            for probability, label in zip(clipped, labels, strict=True)
        ) / len(labels),
        "weakPatchCalibration": weak_patch,
        "requiredSourceDiagnostic": required_source,
    }
    target = Path(args.out).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
    concise = {
        "out": str(target),
        "samePoolVerified": True,
        "calibrationEce": output["calibrationEce"],
        "calibrationBrier": output["calibrationBrier"],
        "calibrationLogLoss": output["calibrationLogLoss"],
        "crossEncoderCoefficient": output["model"]["coefficients"]["crossEncoderProbability"],
        "weakPatchCalibration": {
            key: value for key, value in weak_patch.items()
            if key not in {"missesAt5", "missesAt64", "caseRows"}
        },
        "requiredSourceDiagnostic": {
            key: value for key, value in required_source.items()
            if key not in {"missesAt5", "missesAt64", "caseRows"}
        },
    }
    print(json.dumps(concise, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
