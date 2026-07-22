#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Evaluate Kairn evidence-ranker promotion gates from a sealed holdout trace."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import statistics
from typing import Any


LANGUAGES = ("python", "typescript", "go", "java", "cpp")
NON_INFERIORITY_MARGIN = 0.02
MAX_EXCLUDED_TOP5_REGRESSION = 0.01
MAX_ECE = 0.05
MAX_RANKER_P95_MS = 10.0
MAX_PRIME_P95_REGRESSION = 0.10
MAX_STATE_MEDIAN_GROWTH = 0.01


def require_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{label} must be an array of non-empty strings")
    if len(set(value)) != len(value):
        raise ValueError(f"{label} contains duplicates")
    return value


def require_number(value: Any, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be a finite non-negative number")
    return float(value)


def require_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be a boolean")
    return value


def read_campaign(target: Path) -> dict[str, Any]:
    root = require_record(json.loads(target.read_text(encoding="utf-8")), "campaign")
    if root.get("schemaVersion") != "ranker-promotion.v1":
        raise ValueError("schemaVersion must be ranker-promotion.v1")
    require_string(root.get("campaignId"), "campaignId")
    sample_only = require_bool(root.get("sampleOnly"), "sampleOnly")
    training_lineages = require_string_list(root.get("trainingRepositoryLineages"), "trainingRepositoryLineages")
    rows = root.get("cases")
    if not isinstance(rows, list) or not rows:
        raise ValueError("cases must be a non-empty array")
    cases = [validate_case(item, index) for index, item in enumerate(rows)]
    ids = [item["id"] for item in cases]
    if len(set(ids)) != len(ids):
        raise ValueError("case ids must be unique")
    holdout_lineages = {item["repositoryLineageId"] for item in cases}
    overlap = sorted(holdout_lineages.intersection(training_lineages))
    if overlap:
        raise ValueError(f"ranker holdout repository lineages overlap training/calibration/holdout data: {', '.join(overlap)}")
    return {**root, "sampleOnly": sample_only, "cases": cases}


def validate_case(value: Any, index: int) -> dict[str, Any]:
    row = require_record(value, f"cases[{index}]")
    language = require_string(row.get("language"), f"cases[{index}].language")
    if language not in LANGUAGES:
        raise ValueError(f"cases[{index}].language is unsupported")
    required = require_string_list(row.get("requiredSourceFiles"), f"cases[{index}].requiredSourceFiles")
    if not required:
        raise ValueError(f"cases[{index}].requiredSourceFiles must not be empty")
    samples = row.get("calibrationSamples")
    if not isinstance(samples, list) or not samples:
        raise ValueError(f"cases[{index}].calibrationSamples must be non-empty")
    normalized_samples = []
    for sample_index, sample_value in enumerate(samples):
        sample = require_record(sample_value, f"cases[{index}].calibrationSamples[{sample_index}]")
        probability = require_number(sample.get("probability"), "calibration probability")
        if probability > 1 or sample.get("label") not in (0, 1):
            raise ValueError("calibration samples require probability in [0,1] and label 0 or 1")
        normalized_samples.append({"probability": probability, "label": int(sample["label"])})
    return {
        "id": require_string(row.get("id"), f"cases[{index}].id"),
        "repositoryLineageId": require_string(row.get("repositoryLineageId"), f"cases[{index}].repositoryLineageId"),
        "language": language,
        "requiredSourceFiles": required,
        "excludedFiles": require_string_list(row.get("excludedFiles", []), f"cases[{index}].excludedFiles"),
        "generatedVendorFiles": require_string_list(row.get("generatedVendorFiles", []), f"cases[{index}].generatedVendorFiles"),
        "allowGeneratedVendorTopOne": require_bool(row.get("allowGeneratedVendorTopOne", False), "allowGeneratedVendorTopOne"),
        "candidatePathsAt64": require_string_list(row.get("candidatePathsAt64"), f"cases[{index}].candidatePathsAt64")[:64],
        "legacyRanking": require_string_list(row.get("legacyRanking"), f"cases[{index}].legacyRanking"),
        "calibratedRanking": require_string_list(row.get("calibratedRanking"), f"cases[{index}].calibratedRanking"),
        "calibrationSamples": normalized_samples,
        "rankerLatencyMs": require_number(row.get("rankerLatencyMs"), "rankerLatencyMs"),
        "legacyPrimeMs": require_number(row.get("legacyPrimeMs"), "legacyPrimeMs"),
        "calibratedPrimeMs": require_number(row.get("calibratedPrimeMs"), "calibratedPrimeMs"),
        "legacyStateBytes": require_number(row.get("legacyStateBytes"), "legacyStateBytes"),
        "calibratedStateBytes": require_number(row.get("calibratedStateBytes"), "calibratedStateBytes"),
        "legacyVerificationPassed": require_bool(row.get("legacyVerificationPassed"), "legacyVerificationPassed"),
        "calibratedVerificationPassed": require_bool(row.get("calibratedVerificationPassed"), "calibratedVerificationPassed"),
        "legacySourceInvariantPassed": require_bool(row.get("legacySourceInvariantPassed"), "legacySourceInvariantPassed"),
        "calibratedSourceInvariantPassed": require_bool(row.get("calibratedSourceInvariantPassed"), "calibratedSourceInvariantPassed"),
    }


def file_recall(cases: list[dict[str, Any]], key: str, limit: int) -> float:
    hits = 0
    total = 0
    for row in cases:
        ranked = set(row[key][:limit])
        hits += sum(item in ranked for item in row["requiredSourceFiles"])
        total += len(row["requiredSourceFiles"])
    return hits / total if total else 1.0


def mean_reciprocal_rank(cases: list[dict[str, Any]], key: str) -> float:
    values = []
    for row in cases:
        positions = {item: index + 1 for index, item in enumerate(row[key])}
        values.extend(1 / positions[item] if item in positions else 0.0 for item in row["requiredSourceFiles"])
    return sum(values) / len(values) if values else 1.0


def excluded_top5_rate(cases: list[dict[str, Any]], key: str) -> float:
    hits = 0
    total = 0
    for row in cases:
        ranked = row[key][:5]
        excluded = set(row["excludedFiles"])
        hits += sum(item in excluded for item in ranked)
        total += len(ranked)
    return hits / total if total else 0.0


def expected_calibration_error(samples: list[dict[str, Any]], bins: int = 10) -> float:
    error = 0.0
    for index in range(bins):
        lower, upper = index / bins, (index + 1) / bins
        members = [
            item for item in samples
            if lower <= item["probability"] < upper or (index == bins - 1 and item["probability"] == 1)
        ]
        if not members:
            continue
        accuracy = sum(item["label"] for item in members) / len(members)
        confidence = sum(item["probability"] for item in members) / len(members)
        error += len(members) / len(samples) * abs(accuracy - confidence)
    return error


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = max(0, min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def relative_growth(current: float, baseline: float) -> float:
    if baseline == 0:
        return 0.0 if current == 0 else math.inf
    return (current - baseline) / baseline


def evaluate(campaign: dict[str, Any]) -> dict[str, Any]:
    cases = campaign["cases"]
    candidate_recall = file_recall(cases, "candidatePathsAt64", 64)
    per_language = {
        language: file_recall([row for row in cases if row["language"] == language], "candidatePathsAt64", 64)
        for language in LANGUAGES
        if any(row["language"] == language for row in cases)
    }
    legacy_recall5 = file_recall(cases, "legacyRanking", 5)
    calibrated_recall5 = file_recall(cases, "calibratedRanking", 5)
    legacy_recall1 = file_recall(cases, "legacyRanking", 1)
    calibrated_recall1 = file_recall(cases, "calibratedRanking", 1)
    legacy_mrr = mean_reciprocal_rank(cases, "legacyRanking")
    calibrated_mrr = mean_reciprocal_rank(cases, "calibratedRanking")
    legacy_excluded = excluded_top5_rate(cases, "legacyRanking")
    calibrated_excluded = excluded_top5_rate(cases, "calibratedRanking")
    generated_violations = [
        row["id"] for row in cases
        if row["calibratedRanking"] and row["calibratedRanking"][0] in set(row["generatedVendorFiles"])
        and not row["allowGeneratedVendorTopOne"]
    ]
    calibration_samples = [sample for row in cases for sample in row["calibrationSamples"]]
    ece = expected_calibration_error(calibration_samples)
    ranker_p95 = percentile([row["rankerLatencyMs"] for row in cases], 0.95)
    legacy_prime_p95 = percentile([row["legacyPrimeMs"] for row in cases], 0.95)
    calibrated_prime_p95 = percentile([row["calibratedPrimeMs"] for row in cases], 0.95)
    prime_growth = relative_growth(calibrated_prime_p95, legacy_prime_p95)
    legacy_state = statistics.median(row["legacyStateBytes"] for row in cases)
    calibrated_state = statistics.median(row["calibratedStateBytes"] for row in cases)
    state_growth = relative_growth(calibrated_state, legacy_state)
    quality_regressions = [
        row["id"] for row in cases
        if (row["legacyVerificationPassed"] and not row["calibratedVerificationPassed"])
        or (row["legacySourceInvariantPassed"] and not row["calibratedSourceInvariantPassed"])
    ]
    checks = {
        "candidateRecallAt64Overall": candidate_recall >= 0.99,
        "candidateRecallAt64PerLanguage": bool(per_language) and all(value >= 0.95 for value in per_language.values()),
        "requiredSourceRecallAt5NonInferior": calibrated_recall5 >= legacy_recall5 - NON_INFERIORITY_MARGIN,
        "recallAt1NonInferior": calibrated_recall1 >= legacy_recall1 - NON_INFERIORITY_MARGIN,
        "mrrNonInferior": calibrated_mrr >= legacy_mrr - NON_INFERIORITY_MARGIN,
        "excludedTop5Regression": calibrated_excluded <= legacy_excluded + MAX_EXCLUDED_TOP5_REGRESSION,
        "generatedVendorTopOne": len(generated_violations) == 0,
        "expectedCalibrationError": ece <= MAX_ECE,
        "rankerP95Latency": ranker_p95 <= MAX_RANKER_P95_MS,
        "primeP95Regression": prime_growth <= MAX_PRIME_P95_REGRESSION,
        "stateSizeGrowth": state_growth <= MAX_STATE_MEDIAN_GROWTH,
        "qualityNonRegression": len(quality_regressions) == 0,
        "fiveLanguageCoverage": set(per_language) == set(LANGUAGES),
    }
    gates_passed = all(checks.values())
    return {
        "schemaVersion": "ranker-promotion-report.v1",
        "campaignId": campaign["campaignId"],
        "sampleOnly": campaign["sampleOnly"],
        "caseCount": len(cases),
        "metrics": {
            "candidateRecallAt64": round(candidate_recall, 6),
            "candidateRecallAt64ByLanguage": {key: round(value, 6) for key, value in per_language.items()},
            "legacyRequiredSourceRecallAt5": round(legacy_recall5, 6),
            "calibratedRequiredSourceRecallAt5": round(calibrated_recall5, 6),
            "legacyRecallAt1": round(legacy_recall1, 6),
            "calibratedRecallAt1": round(calibrated_recall1, 6),
            "legacyMrr": round(legacy_mrr, 6),
            "calibratedMrr": round(calibrated_mrr, 6),
            "legacyExcludedTop5Rate": round(legacy_excluded, 6),
            "calibratedExcludedTop5Rate": round(calibrated_excluded, 6),
            "expectedCalibrationError": round(ece, 6),
            "rankerP95Ms": round(ranker_p95, 6),
            "legacyPrimeP95Ms": round(legacy_prime_p95, 6),
            "calibratedPrimeP95Ms": round(calibrated_prime_p95, 6),
            "primeP95RegressionRate": round(prime_growth, 6),
            "legacyMedianStateBytes": legacy_state,
            "calibratedMedianStateBytes": calibrated_state,
            "stateSizeGrowthRate": round(state_growth, 6),
            "generatedVendorTopOneViolations": generated_violations,
            "qualityRegressionCases": quality_regressions,
        },
        "checks": checks,
        "gatesPassed": gates_passed,
        "promotionEligible": gates_passed and not campaign["sampleOnly"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--allow-sample", action="store_true", help="Validate gate mechanics without treating sample data as promotion evidence")
    args = parser.parse_args()
    campaign = read_campaign(args.input.resolve())
    if campaign["sampleOnly"] and not args.allow_sample:
        raise ValueError("sample-only promotion input requires --allow-sample and can never make promotionEligible true")
    report = evaluate(campaign)
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if report["gatesPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
