#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Train-only shallow nonlinear ceiling for Kairn's frozen candidate pools."""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
from typing import Any


FEATURES = [
    "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25",
    "keyword", "semantic", "failureReference", "gitChanged",
    "alreadyDelivered", "graphNeighbor", "graphPrecision", "graphConsensus",
    "graphSupport", "graphSeedStrength", "graphIndependentEvidence", "sourceTestPair",
    "productionSource", "testFile", "docsFile", "generatedVendor",
    "intentRoleMatch", "importance", "contentCost", "missingSymbols",
    "missingLexical",
]


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-min(value, 700)))
    exponent = math.exp(max(value, -700))
    return exponent / (1.0 + exponent)


def score(model: dict[str, Any], features: list[float]) -> float:
    return model["intercept"] + model["learningRate"] * sum(
        stump["left"] if features[stump["feature"]] <= stump["threshold"] else stump["right"]
        for stump in model["stumps"]
    )


def train_stumps(rows: list[dict[str, Any]], iterations: int, learning_rate: float) -> dict[str, Any]:
    total_weight = sum(row["labelWeight"] for row in rows)
    positive_rate = min(
        1 - 1e-6,
        max(1e-6, sum(row["label"] * row["labelWeight"] for row in rows) / total_weight),
    )
    model: dict[str, Any] = {
        "intercept": math.log(positive_rate / (1 - positive_rate)),
        "learningRate": learning_rate,
        "stumps": [],
    }
    for _ in range(iterations):
        residuals = [row["label"] - sigmoid(score(model, row["features"])) for row in rows]
        best: dict[str, Any] | None = None
        for feature in range(len(FEATURES)):
            values = sorted(row["features"][feature] for row in rows)
            thresholds = {
                values[min(len(values) - 1, math.floor(len(values) * fraction))]
                for fraction in (0.25, 0.5, 0.75)
            }
            for threshold in sorted(thresholds):
                left_indices = [index for index, row in enumerate(rows) if row["features"][feature] <= threshold]
                right_indices = [index for index, row in enumerate(rows) if row["features"][feature] > threshold]
                if not left_indices or not right_indices:
                    continue
                left = weighted_average(residuals, rows, left_indices)
                right = weighted_average(residuals, rows, right_indices)
                error = sum(
                    rows[index]["labelWeight"]
                    * (residual - (left if rows[index]["features"][feature] <= threshold else right)) ** 2
                    for index, residual in enumerate(residuals)
                )
                candidate = {
                    "error": error,
                    "stump": {"feature": feature, "threshold": threshold, "left": left, "right": right},
                }
                if best is None or (candidate["error"], feature, threshold) < (
                    best["error"], best["stump"]["feature"], best["stump"]["threshold"]
                ):
                    best = candidate
        if best is None:
            break
        model["stumps"].append(best["stump"])
    return model


def weighted_average(values: list[float], rows: list[dict[str, Any]], indices: list[int]) -> float:
    denominator = sum(rows[index]["labelWeight"] for index in indices)
    return sum(values[index] * rows[index]["labelWeight"] for index in indices) / denominator


def fit_platt(rows: list[dict[str, Any]], model: dict[str, Any]) -> tuple[float, float]:
    scores = [score(model, row["features"]) for row in rows]
    a, b = 1.0, 0.0
    total_weight = max(1.0, sum(row["labelWeight"] for row in rows))
    for iteration in range(1200):
        gradient_a = 0.0
        gradient_b = 0.0
        for row, raw in zip(rows, scores, strict=True):
            error = (sigmoid(a * raw + b) - row["label"]) * row["labelWeight"]
            gradient_a += error * raw
            gradient_b += error
        rate = 0.15 / (1.0 + iteration / 250.0)
        a -= rate * gradient_a / total_weight
        b -= rate * gradient_b / total_weight
    return a, b


def expected_calibration_error(rows: list[dict[str, Any]], model: dict[str, Any], a: float, b: float) -> float:
    samples = [(row["label"], sigmoid(a * score(model, row["features"]) + b)) for row in rows]
    error = 0.0
    for index in range(10):
        lower, upper = index / 10, (index + 1) / 10
        members = [
            sample for sample in samples
            if lower <= sample[1] < upper or (index == 9 and sample[1] == 1)
        ]
        if members:
            accuracy = sum(label for label, _ in members) / len(members)
            confidence = sum(probability for _, probability in members) / len(members)
            error += len(members) / len(samples) * abs(accuracy - confidence)
    return error


def evaluate_cases(
    cases: list[dict[str, Any]], reports: dict[str, dict[str, Any]], model: dict[str, Any], reference: str
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    failure_index = FEATURES.index("failureReference")
    exact_path_index = FEATURES.index("exactPath")
    generated_index = FEATURES.index("generatedVendor")
    for case in cases:
        case_id = case["id"]
        report = reports[case_id]
        required = report[reference]
        if not required:
            continue
        ranked = []
        for candidate in case["trainingCandidates"]:
            features = [float(candidate["features"][feature]) for feature in FEATURES]
            priority = 2 if features[failure_index] > 0 else 1 if features[exact_path_index] > 0 else 0
            ranked.append({
                "path": candidate["path"],
                "priority": priority,
                "score": score(model, features),
                "generatedVendor": features[generated_index] > 0,
            })
        ranked.sort(key=lambda item: (-item["priority"], -item["score"], item["path"]))
        positions = {candidate["path"]: index + 1 for index, candidate in enumerate(ranked)}
        ranks = [positions.get(file_path) for file_path in required]
        results.append({
            "id": case_id,
            "language": case["language"],
            "scenario": case["scenario"],
            "requiredFiles": required,
            "requiredFileRanks": dict(zip(required, ranks, strict=True)),
            "generatedVendorTopOne": bool(ranked and ranked[0]["generatedVendor"]),
        })
    ranks = [rank for result in results for rank in result["requiredFileRanks"].values()]
    return {
        "cases": len(results),
        "requiredFiles": len(ranks),
        "recallAt1": recall(ranks, 1),
        "recallAt5": recall(ranks, 5),
        "recallAt64": recall(ranks, 64),
        "recallAt128": recall(ranks, 128),
        "mrr": sum(0 if rank is None else 1 / rank for rank in ranks) / len(ranks),
        "strictFullRecallAt64": sum(
            all(rank is not None and rank <= 64 for rank in result["requiredFileRanks"].values())
            for result in results
        ) / len(results),
        "strictFullRecallAt128": sum(
            all(rank is not None and rank <= 128 for rank in result["requiredFileRanks"].values())
            for result in results
        ) / len(results),
        "generatedVendorTopOneViolations": [result["id"] for result in results if result["generatedVendorTopOne"]],
        "missesAt5": [
            {"id": result["id"], "requiredFileRanks": result["requiredFileRanks"]}
            for result in results
            if not all(rank is not None and rank <= 5 for rank in result["requiredFileRanks"].values())
        ],
        "missesAt64": [
            {"id": result["id"], "requiredFileRanks": result["requiredFileRanks"]}
            for result in results
            if not all(rank is not None and rank <= 64 for rank in result["requiredFileRanks"].values())
        ],
    }


def recall(ranks: list[int | None], limit: int) -> float:
    return sum(rank is not None and rank <= limit for rank in ranks) / len(ranks)


def read_training_rows(target: Path) -> tuple[list[dict[str, Any]], bytes]:
    raw = target.read_bytes()
    rows = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    labeled = [row for row in rows if row.get("label") in (0, 1)]
    if not labeled or any(row.get("featureSchemaVersion") != "evidence-features-v4" for row in labeled):
        raise ValueError("training rows must be labeled evidence-features-v4 rows")
    return labeled, raw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-rows", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--iterations", type=int, default=40)
    parser.add_argument("--learning-rate", type=float, default=0.15)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 100:
        raise ValueError("--iterations must be between 1 and 100")
    if not 0 < args.learning_rate <= 0.5:
        raise ValueError("--learning-rate must be greater than zero and at most 0.5")

    training_path = Path(args.training_rows).resolve()
    manifest_path = Path(args.manifest).resolve()
    report_path = Path(args.report).resolve()
    rows, training_bytes = read_training_rows(training_path)
    train = [row for row in rows if row["split"] == "train"]
    calibration = [row for row in rows if row["split"] == "calibration"]
    manifest_bytes = manifest_path.read_bytes()
    report_bytes = report_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    report = json.loads(report_bytes)
    if manifest.get("featureSchemaVersion") != "evidence-features-v4":
        raise ValueError("manifest feature schema mismatch")
    if manifest.get("materializer", {}).get("intakeSha256") != report.get("intakeSha256"):
        raise ValueError("manifest/report provenance mismatch")
    cases = manifest["cases"]
    reports = {item["id"]: item for item in report["cases"]}
    if len(cases) != 135 or len(reports) != 135:
        raise ValueError("diagnostic requires the exact 135-case train/calibration corpus")

    model = train_stumps(train, args.iterations, args.learning_rate)
    platt_a, platt_b = fit_platt(calibration, model)
    output = {
        "schemaVersion": "shallow-ranker-diagnostic.v1",
        "promotionEligible": False,
        "reason": "Train-only shallow nonlinear mechanism probe over frozen train/calibration pools; not a runtime model or holdout result.",
        "inputs": {
            "trainingRowsSha256": hashlib.sha256(training_bytes).hexdigest(),
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "reportSha256": hashlib.sha256(report_bytes).hexdigest(),
        },
        "model": {
            "kind": "gradient_boosted_stumps",
            "iterations": len(model["stumps"]),
            "learningRate": model["learningRate"],
            "intercept": model["intercept"],
            "stumps": model["stumps"],
            "calibration": {"kind": "platt", "a": platt_a, "b": platt_b},
        },
        "calibrationEce": expected_calibration_error(calibration, model, platt_a, platt_b),
        "weakPatchCalibration": evaluate_cases(
            [case for case in cases if case["split"] == "calibration"],
            reports,
            model,
            "officialPatchSourceExistingFiles",
        ),
        "requiredSourceDiagnostic": evaluate_cases(
            cases, reports, model, "requiredSourceExistingFiles"
        ),
    }
    target = Path(args.out).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "out": str(target),
        "calibrationEce": output["calibrationEce"],
        "weakPatchCalibration": output["weakPatchCalibration"],
        "requiredSourceDiagnostic": output["requiredSourceDiagnostic"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
