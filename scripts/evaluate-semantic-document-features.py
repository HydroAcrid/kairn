#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Probe whole-file versus symbol-body semantic evidence on frozen pools."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import sys
from typing import Any


BASE_FEATURES = [
    "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25",
    "keyword", "semantic", "failureReference", "gitChanged",
    "alreadyDelivered", "graphNeighbor", "graphPrecision", "graphConsensus",
    "graphSupport", "graphSeedStrength", "graphIndependentEvidence", "sourceTestPair",
    "productionSource", "testFile", "docsFile", "generatedVendor",
    "intentRoleMatch", "importance", "contentCost", "missingSymbols",
    "missingLexical",
]
DOCUMENT_FEATURES = [
    "semanticFile",
    "semanticSymbol",
    "missingSemanticFile",
    "missingSemanticSymbol",
]
FEATURES = BASE_FEATURES + DOCUMENT_FEATURES


def load_trainer() -> Any:
    target = Path(__file__).resolve().with_name("train-evidence-ranker.py")
    spec = importlib.util.spec_from_file_location("kairn_evidence_trainer", target)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load evidence-ranker trainer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.FEATURES = FEATURES
    return module


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def document_features(interaction: dict[str, Any] | None) -> list[float]:
    if interaction is None:
        return [0.0, 0.0, 1.0, 1.0]
    file_value = interaction.get("fileSimilarity")
    symbol_value = interaction.get("symbolSimilarity")
    has_file = isinstance(file_value, (int, float))
    has_symbol = isinstance(symbol_value, (int, float))
    return [
        clamp01(float(file_value)) if has_file else 0.0,
        clamp01(float(symbol_value)) if has_symbol else 0.0,
        0.0 if has_file else 1.0,
        0.0 if has_symbol else 1.0,
    ]


def case_paths(case: dict[str, Any]) -> list[str]:
    return [str(candidate["path"]) for candidate in case["trainingCandidates"]]


def verify_frozen_pool(
    baseline_manifest: dict[str, Any],
    candidate_manifest: dict[str, Any],
) -> None:
    baseline = {case["id"]: case for case in baseline_manifest["cases"]}
    candidate = {case["id"]: case for case in candidate_manifest["cases"]}
    if set(baseline) != set(candidate) or len(baseline) != 135:
        raise ValueError("candidate and baseline must contain the identical 135 case IDs")
    for case_id in sorted(baseline):
        left = baseline[case_id]
        right = candidate[case_id]
        if case_paths(left) != case_paths(right):
            raise ValueError(f"{case_id}: frozen candidate pool changed")
        for left_row, right_row in zip(
            left["trainingCandidates"], right["trainingCandidates"], strict=True
        ):
            if left_row["features"] != right_row["features"]:
                raise ValueError(f"{case_id}:{left_row['path']}: base feature vector changed")


def verify_baseline_evaluation_pool(
    evaluation: dict[str, Any],
    manifest_sha256: str,
    report_sha256: str,
    label: str,
) -> None:
    inputs = evaluation.get("inputs")
    if not isinstance(inputs, dict):
        raise ValueError(f"{label}: baseline evaluation inputs are missing")
    manifest = inputs.get("manifest")
    report = inputs.get("report")
    if not isinstance(manifest, dict) or manifest.get("sha256") != manifest_sha256:
        raise ValueError(f"{label}: baseline evaluation manifest differs from the frozen pool")
    if not isinstance(report, dict) or report.get("sha256") != report_sha256:
        raise ValueError(f"{label}: baseline evaluation report differs from the selector probe")
    if evaluation.get("candidatePool") != "auto":
        raise ValueError(f"{label}: baseline evaluation must use the automatic probe pool")


def interaction_maps(report: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    result: dict[str, dict[str, dict[str, Any]]] = {}
    for case in report["cases"]:
        diagnostics = case.get("candidateDiagnostics", {})
        interactions = diagnostics.get("semanticInteractions")
        if not isinstance(interactions, list):
            raise ValueError(f"{case['id']}: semantic document interactions are missing")
        result[case["id"]] = {str(item["path"]): item for item in interactions}
    return result


def read_rows(
    target: Path,
    interactions: dict[str, dict[str, dict[str, Any]]],
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
        if case_interactions is None:
            raise ValueError(f"line {line_number}: missing case interactions for {case_id}")
        rows.append({
            **row,
            "featureSchemaVersion": "evidence-features-v5-diagnostic",
            "features": [float(value) for value in base] + document_features(
                case_interactions.get(candidate_path)
            ),
            "labelWeight": float(row["labelWeight"]),
        })
    return rows, raw


def evaluate_cases(
    cases: list[dict[str, Any]],
    reports: dict[str, dict[str, Any]],
    interactions: dict[str, dict[str, dict[str, Any]]],
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
        case_id = case["id"]
        required = reports[case_id][reference]
        if not required:
            continue
        probe_candidates = reports[case_id].get("probeCandidates")
        if not isinstance(probe_candidates, list) or not probe_candidates:
            raise ValueError(f"{case_id}: selector evaluation requires probe candidates")
        ranked: list[dict[str, Any]] = []
        for candidate in probe_candidates:
            base = [float(candidate["features"][name]) for name in BASE_FEATURES]
            features = base + document_features(interactions[case_id].get(candidate["path"]))
            priority = 2 if features[failure_index] > 0 else 1 if features[exact_path_index] > 0 else 0
            ranked.append({
                "path": candidate["path"],
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
        "caseRows": results,
    }


def metric_for_cases(cases: list[dict[str, Any]], metric: str) -> float:
    ranks = [rank for case in cases for rank in case["ranks"].values()]
    if not ranks:
        raise ValueError("paired comparison has no required-file ranks")
    if metric == "mrr":
        return sum(0 if rank is None else 1 / rank for rank in ranks) / len(ranks)
    limit = {"recallAt5": 5, "recallAt64": 64}[metric]
    return sum(rank is not None and rank <= limit for rank in ranks) / len(ranks)


def normalize_baseline_cases(value: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"id": case["id"], "ranks": case["requiredFileRanks"]}
        for case in value["cases"]
    ]


def paired_comparison(
    candidate_cases: list[dict[str, Any]],
    baseline_cases: list[dict[str, Any]],
    seed: int = 20260827,
    samples: int = 10_000,
) -> dict[str, Any]:
    candidate_by_id = {case["id"]: case for case in candidate_cases}
    baseline_by_id = {case["id"]: case for case in baseline_cases}
    if set(candidate_by_id) != set(baseline_by_id):
        raise ValueError("paired comparison case IDs differ")
    ids = sorted(candidate_by_id)
    for case_id in ids:
        if set(candidate_by_id[case_id]["ranks"]) != set(baseline_by_id[case_id]["ranks"]):
            raise ValueError(f"{case_id}: paired required-file populations differ")
    generator = random.Random(seed)
    output: dict[str, Any] = {
        "cases": len(ids),
        "bootstrapSamples": samples,
        "bootstrapSeed": seed,
        "metrics": {},
    }
    for metric in ("recallAt5", "mrr", "recallAt64"):
        baseline_value = metric_for_cases([baseline_by_id[case_id] for case_id in ids], metric)
        candidate_value = metric_for_cases([candidate_by_id[case_id] for case_id in ids], metric)
        deltas: list[float] = []
        for _ in range(samples):
            selected = [ids[generator.randrange(len(ids))] for _ in ids]
            deltas.append(
                metric_for_cases([candidate_by_id[case_id] for case_id in selected], metric)
                - metric_for_cases([baseline_by_id[case_id] for case_id in selected], metric)
            )
        deltas.sort()
        output["metrics"][metric] = {
            "baseline": baseline_value,
            "candidate": candidate_value,
            "delta": candidate_value - baseline_value,
            "paired95Ci": [deltas[249], deltas[9749]],
        }
    return output


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--":
        argv = argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-rows", required=True)
    parser.add_argument("--baseline-manifest", required=True)
    parser.add_argument("--candidate-manifest", required=True)
    parser.add_argument("--candidate-report", required=True)
    parser.add_argument("--baseline-calibration-evaluation", required=True)
    parser.add_argument("--baseline-required-evaluation", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--objective", choices=["pointwise", "pairwise"], default="pointwise")
    args = parser.parse_args(argv)

    training_path = Path(args.training_rows).resolve()
    baseline_path = Path(args.baseline_manifest).resolve()
    candidate_path = Path(args.candidate_manifest).resolve()
    report_path = Path(args.candidate_report).resolve()
    baseline_calibration_path = Path(args.baseline_calibration_evaluation).resolve()
    baseline_required_path = Path(args.baseline_required_evaluation).resolve()
    baseline_bytes = baseline_path.read_bytes()
    candidate_bytes = candidate_path.read_bytes()
    report_bytes = report_path.read_bytes()
    baseline_calibration_bytes = baseline_calibration_path.read_bytes()
    baseline_required_bytes = baseline_required_path.read_bytes()
    baseline = json.loads(baseline_bytes)
    candidate = json.loads(candidate_bytes)
    report = json.loads(report_bytes)
    baseline_calibration = json.loads(baseline_calibration_bytes)
    baseline_required = json.loads(baseline_required_bytes)
    verify_frozen_pool(baseline, candidate)
    if candidate.get("materializer", {}).get("intakeSha256") != report.get("intakeSha256"):
        raise ValueError("candidate manifest/report provenance mismatch")
    baseline_manifest_sha256 = hashlib.sha256(baseline_bytes).hexdigest()
    candidate_report_sha256 = hashlib.sha256(report_bytes).hexdigest()
    verify_baseline_evaluation_pool(
        baseline_calibration,
        baseline_manifest_sha256,
        candidate_report_sha256,
        "calibration baseline",
    )
    verify_baseline_evaluation_pool(
        baseline_required,
        baseline_manifest_sha256,
        candidate_report_sha256,
        "required-source baseline",
    )
    interactions = interaction_maps(report)
    rows, training_bytes = read_rows(training_path, interactions)
    train = [row for row in rows if row["split"] == "train"]
    calibration = [row for row in rows if row["split"] == "calibration"]
    trainer = load_trainer()
    if args.objective == "pairwise":
        selected_l2, cv_scores = trainer.choose_l2_pairwise(train)
        pairs = trainer.build_pairwise_rows(train)
        intercept = 0.0
        coefficients = trainer.train_pairwise_logistic(pairs, selected_l2)
    else:
        selected_l2, cv_scores = trainer.choose_l2(train)
        pairs = []
        intercept, coefficients = trainer.train_logistic(train, selected_l2)
    platt_a, platt_b = trainer.fit_platt(calibration, intercept, coefficients)
    probabilities = trainer.calibrated_probabilities(
        calibration, intercept, coefficients, platt_a, platt_b
    )
    reports = {item["id"]: item for item in report["cases"]}
    output = {
        "schemaVersion": "semantic-document-feature-diagnostic.v1",
        "promotionEligible": False,
        "reason": (
            "Train/calibration-only frozen-pool probe. Production schema and inference "
            "must be implemented and rematerialized before promotion."
        ),
        "inputs": {
            "trainingRowsSha256": hashlib.sha256(training_bytes).hexdigest(),
            "baselineManifestSha256": hashlib.sha256(baseline_bytes).hexdigest(),
            "candidateManifestSha256": hashlib.sha256(candidate_bytes).hexdigest(),
            "candidateReportSha256": hashlib.sha256(report_bytes).hexdigest(),
            "baselineCalibrationSha256": hashlib.sha256(baseline_calibration_bytes).hexdigest(),
            "baselineRequiredSha256": hashlib.sha256(baseline_required_bytes).hexdigest(),
        },
        "samePoolVerified": True,
        "featureSchema": {"base": BASE_FEATURES, "added": DOCUMENT_FEATURES},
        "model": {
            "kind": f"{args.objective}_logistic",
            "trainingPairs": len(pairs),
            "selectedL2": selected_l2,
            "crossValidationLogLoss": cv_scores,
            "intercept": intercept,
            "coefficients": dict(zip(FEATURES, coefficients, strict=True)),
            "calibration": {"kind": "platt", "a": platt_a, "b": platt_b},
        },
        "calibrationEce": trainer.expected_calibration_error(
            [row["label"] for row in calibration], probabilities
        ),
        "weakPatchCalibration": evaluate_cases(
            [case for case in candidate["cases"] if case["split"] == "calibration"],
            reports, interactions, trainer, intercept, coefficients,
            "officialPatchSourceExistingFiles",
        ),
        "requiredSourceDiagnostic": evaluate_cases(
            candidate["cases"], reports, interactions, trainer, intercept, coefficients,
            "requiredSourceExistingFiles",
        ),
    }
    output["comparisonsToV166"] = {
        "weakPatchCalibration": paired_comparison(
            output["weakPatchCalibration"]["caseRows"],
            normalize_baseline_cases(baseline_calibration),
        ),
        "requiredSourceDiagnostic": paired_comparison(
            output["requiredSourceDiagnostic"]["caseRows"],
            normalize_baseline_cases(baseline_required),
        ),
    }
    target = Path(args.out).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
    concise = {
        "out": str(target),
        "samePoolVerified": True,
        "calibrationEce": output["calibrationEce"],
        "weakPatchCalibration": {
            key: value for key, value in output["weakPatchCalibration"].items()
            if key not in {"missesAt5", "missesAt64", "caseRows"}
        },
        "requiredSourceDiagnostic": {
            key: value for key, value in output["requiredSourceDiagnostic"].items()
            if key not in {"missesAt5", "missesAt64", "caseRows"}
        },
        "comparisonsToV166": output["comparisonsToV166"],
    }
    print(json.dumps(concise, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
