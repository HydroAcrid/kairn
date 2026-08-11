#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Train Kairn's dependency-free local evidence ranker from public JSONL rows."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import subprocess
from typing import Any, Iterable
from urllib.parse import urlparse


FEATURES = [
    "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25",
    "keyword", "semantic", "failureReference", "gitChanged",
    "alreadyDelivered", "graphNeighbor", "graphPrecision", "graphConsensus",
    "graphSupport", "graphSeedStrength", "graphIndependentEvidence",
    "modelCorroboratedImporter", "sourceTestPair",
    "productionSource", "testFile", "docsFile", "generatedVendor",
    "intentRoleMatch", "importance", "contentCost", "missingSymbols",
    "missingLexical",
]
SCHEMA_VERSION = "evidence-features-v5"
L2_GRID = [0.0001, 0.001, 0.01, 0.1, 1.0]
LABEL_POLICIES: dict[str, tuple[int, float]] = {
    "required_source_oracle": (1, 1.0),
    "explicit_noise_or_excluded": (0, 1.0),
    "verified_official_patch_source": (1, 0.75),
    "quality_passing_observed_read_touch": (1, 0.25),
}
DATA_ORIGINS = {"public_benchmark", "public_patch", "synthetic"}


def sigmoid(value: float) -> float:
    if value >= 0:
        exponent = math.exp(-min(value, 700))
        return 1.0 / (1.0 + exponent)
    exponent = math.exp(max(value, -700))
    return exponent / (1.0 + exponent)


def raw_score(intercept: float, coefficients: list[float], features: list[float]) -> float:
    return intercept + sum(coefficient * feature for coefficient, feature in zip(coefficients, features, strict=True))


def train_logistic(rows: list[dict[str, Any]], l2: float, iterations: int = 1800) -> tuple[float, list[float]]:
    intercept = 0.0
    coefficients = [0.0] * len(FEATURES)
    total_weight = max(1.0, sum(row["labelWeight"] for row in rows))
    for iteration in range(iterations):
        gradient_intercept = 0.0
        gradients = [0.0] * len(FEATURES)
        for row in rows:
            prediction = sigmoid(raw_score(intercept, coefficients, row["features"]))
            error = (prediction - row["label"]) * row["labelWeight"]
            gradient_intercept += error
            for index, feature in enumerate(row["features"]):
                gradients[index] += error * feature
        learning_rate = 0.3 / (1.0 + iteration / 300.0)
        intercept -= learning_rate * gradient_intercept / total_weight
        for index in range(len(coefficients)):
            regularized = gradients[index] / total_weight + l2 * coefficients[index]
            coefficients[index] -= learning_rate * regularized
    return intercept, coefficients


def log_loss(rows: list[dict[str, Any]], intercept: float, coefficients: list[float]) -> float:
    if not rows:
        return float("inf")
    weighted = 0.0
    total_weight = 0.0
    for row in rows:
        probability = min(1 - 1e-12, max(1e-12, sigmoid(raw_score(intercept, coefficients, row["features"]))))
        label = row["label"]
        weight = row["labelWeight"]
        weighted += -weight * (label * math.log(probability) + (1 - label) * math.log(1 - probability))
        total_weight += weight
    return weighted / max(total_weight, 1e-12)


def choose_l2(rows: list[dict[str, Any]]) -> tuple[float, dict[str, float]]:
    groups = sorted(
        {row["repositoryLineageId"] for row in rows},
        key=lambda value: (hashlib.sha256(value.encode()).hexdigest(), value),
    )
    folds = min(5, len(groups))
    if folds < 2:
        raise ValueError("training split needs at least two repository lineages for grouped cross-validation")
    # Assign sorted groups round-robin so every fold is populated. A direct
    # hash modulo can leave folds empty on smaller public training sets.
    fold_by_group = {group: index % folds for index, group in enumerate(groups)}
    scores: dict[str, float] = {}
    for l2 in L2_GRID:
        losses: list[float] = []
        for fold in range(folds):
            train = [row for row in rows if fold_by_group[row["repositoryLineageId"]] != fold]
            validation = [row for row in rows if fold_by_group[row["repositoryLineageId"]] == fold]
            if not train or not validation:
                continue
            losses.append(log_loss(validation, *train_logistic(train, l2, iterations=700)))
        scores[str(l2)] = sum(losses) / len(losses) if losses else float("inf")
    selected = min(L2_GRID, key=lambda value: (scores[str(value)], value))
    return selected, scores


def fit_platt(rows: list[dict[str, Any]], intercept: float, coefficients: list[float]) -> tuple[float, float]:
    if not rows:
        return 1.0, 0.0
    scores = [raw_score(intercept, coefficients, row["features"]) for row in rows]
    a, b = 1.0, 0.0
    total_weight = max(1.0, sum(row["labelWeight"] for row in rows))
    for iteration in range(1200):
        gradient_a = 0.0
        gradient_b = 0.0
        for row, score in zip(rows, scores, strict=True):
            error = (sigmoid(a * score + b) - row["label"]) * row["labelWeight"]
            gradient_a += error * score
            gradient_b += error
        rate = 0.15 / (1.0 + iteration / 250.0)
        a -= rate * gradient_a / total_weight
        b -= rate * gradient_b / total_weight
    return a, b


def calibrated_probabilities(
    rows: list[dict[str, Any]], intercept: float, coefficients: list[float], a: float, b: float
) -> list[float]:
    return [sigmoid(a * raw_score(intercept, coefficients, row["features"]) + b) for row in rows]


def recall_threshold(rows: list[dict[str, Any]], probabilities: list[float], target_recall: float) -> float:
    positives = [(probability, row["labelWeight"]) for row, probability in zip(rows, probabilities, strict=True) if row["label"] == 1]
    if not positives:
        return 1.0
    total = sum(weight for _, weight in positives)
    candidates = sorted({0.0, 1.0, *(probability for probability, _ in positives)})
    valid = []
    for threshold in candidates:
        recall = sum(weight for probability, weight in positives if probability >= threshold) / total
        if recall >= target_recall:
            valid.append(threshold)
    return max(valid) if valid else 0.0


def expected_calibration_error(labels: list[int], probabilities: list[float], bins: int = 10) -> float:
    if not labels:
        return 0.0
    total = len(labels)
    error = 0.0
    for index in range(bins):
        lower, upper = index / bins, (index + 1) / bins
        members = [
            (label, probability)
            for label, probability in zip(labels, probabilities, strict=True)
            if lower <= probability < upper or (index == bins - 1 and probability == 1)
        ]
        if not members:
            continue
        accuracy = sum(label for label, _ in members) / len(members)
        confidence = sum(probability for _, probability in members) / len(members)
        error += len(members) / total * abs(accuracy - confidence)
    return error


def evaluate(rows: list[dict[str, Any]], probabilities: list[float]) -> dict[str, float | int]:
    labels = [row["label"] for row in rows]
    predictions = [1 if probability >= 0.5 else 0 for probability in probabilities]
    return {
        "rows": len(rows),
        "positiveRows": sum(labels),
        "accuracyAtHalf": round(sum(int(left == right) for left, right in zip(labels, predictions, strict=True)) / max(1, len(labels)), 6),
        "expectedCalibrationError": round(expected_calibration_error(labels, probabilities), 6),
    }


def read_rows(target: Path) -> tuple[list[dict[str, Any]], bytes]:
    raw = target.read_bytes()
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        value = json.loads(line)
        if value.get("label") not in (0, 1, None):
            raise ValueError(f"line {line_number}: label must be 0, 1, or null")
        if value.get("isPublic") is not True:
            raise ValueError(f"line {line_number}: corpus rows must declare isPublic=true")
        public_source = value.get("publicSourceUrl")
        parsed_source = urlparse(public_source) if isinstance(public_source, str) else None
        if not parsed_source or parsed_source.scheme != "https" or not parsed_source.netloc:
            raise ValueError(f"line {line_number}: publicSourceUrl must be an absolute HTTPS URL")
        if value.get("dataOrigin") not in DATA_ORIGINS:
            raise ValueError(f"line {line_number}: dataOrigin must name public benchmark, patch, or synthetic data")
        repository_lineage = value.get("repositoryLineageId")
        if not isinstance(repository_lineage, str) or not repository_lineage:
            raise ValueError(f"line {line_number}: repositoryLineageId is required")
        lineage_url = urlparse(repository_lineage)
        if (
            not repository_lineage.startswith(("synthetic:", "synthetic-"))
            and (lineage_url.scheme != "https" or not lineage_url.netloc)
        ):
            raise ValueError(f"line {line_number}: public repositoryLineageId must be a canonical HTTPS repository URL")
        if value.get("featureSchemaVersion") != SCHEMA_VERSION:
            raise ValueError(f"line {line_number}: feature schema mismatch")
        features = value.get("features")
        if not isinstance(features, list) or len(features) != len(FEATURES) or not all(isinstance(item, (int, float)) and math.isfinite(item) for item in features):
            raise ValueError(f"line {line_number}: features must contain {len(FEATURES)} finite numbers")
        if any(item < 0 or item > 1 for item in features):
            raise ValueError(f"line {line_number}: normalized feature values must be between zero and one")
        split = value.get("split")
        if split not in {"train", "calibration", "holdout"}:
            raise ValueError(f"line {line_number}: split must be train, calibration, or holdout")
        case_group = value.get("caseGroupId")
        if not isinstance(case_group, str) or not case_group:
            raise ValueError(f"line {line_number}: caseGroupId is required")
        if value.get("label") is None:
            if value.get("labelWeight") is not None or value.get("labelProvenance") is not None:
                raise ValueError(f"line {line_number}: unlabeled rows must omit labelWeight and labelProvenance")
            continue
        weight = value.get("labelWeight", 1.0)
        if not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
            raise ValueError(f"line {line_number}: labelWeight must be positive")
        provenance = value.get("labelProvenance")
        expected_policy = LABEL_POLICIES.get(provenance) if isinstance(provenance, str) else None
        if expected_policy is None:
            raise ValueError(f"line {line_number}: unsupported labelProvenance; unapproved candidates must remain unlabeled")
        if (value["label"], float(weight)) != expected_policy:
            raise ValueError(
                f"line {line_number}: {provenance} requires label={expected_policy[0]} "
                f"and labelWeight={expected_policy[1]}"
            )
        rows.append({**value, "features": [float(item) for item in features], "labelWeight": float(weight)})
    splits_by_group: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        splits_by_group[row["caseGroupId"]].add(row["split"])
    contaminated = [group for group, splits in splits_by_group.items() if len(splits) > 1]
    if contaminated:
        raise ValueError(f"case groups cross data splits: {', '.join(contaminated[:10])}")
    lineages_by_split: dict[str, set[str]] = defaultdict(set)
    groups_by_lineage: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        lineages_by_split[row["repositoryLineageId"]].add(row["split"])
        groups_by_lineage[row["caseGroupId"]].add(row["repositoryLineageId"])
    contaminated_lineages = [lineage for lineage, splits in lineages_by_split.items() if len(splits) > 1]
    if contaminated_lineages:
        raise ValueError(f"repository lineages cross data splits: {', '.join(contaminated_lineages[:10])}")
    ambiguous_groups = [group for group, lineages in groups_by_lineage.items() if len(lineages) > 1]
    if ambiguous_groups:
        raise ValueError(f"case groups cross repository lineages: {', '.join(ambiguous_groups[:10])}")
    return rows, raw


def schema_hash() -> str:
    value = json.dumps({"features": FEATURES, "version": SCHEMA_VERSION}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()


def artifact_checksum(artifact: dict[str, Any], node_command: str, helper: Path) -> str:
    completed = subprocess.run(
        [node_command, str(helper)],
        input=json.dumps(artifact, separators=(",", ":")),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0 or not re_sha256(completed.stdout.strip()):
        raise RuntimeError(f"artifact checksum helper failed: {completed.stderr.strip()}")
    return completed.stdout.strip()


def re_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value.lower())


def rounded(values: Iterable[float]) -> list[float]:
    return [round(value, 12) for value in values]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument(
        "--detached-holdout",
        action="store_true",
        help=(
            "Freeze from train/calibration rows before a separate lineage-disjoint "
            "single-use holdout is attached and opened."
        ),
    )
    parser.add_argument(
        "--public-data-only",
        action="store_true",
        required=True,
        help="Required acknowledgement that the input contains only public or synthetic data.",
    )
    args = parser.parse_args()

    source = Path(args.input).resolve()
    output = Path(args.out).resolve()
    rows, raw = read_rows(source)
    train = [row for row in rows if row["split"] == "train"]
    calibration = [row for row in rows if row["split"] == "calibration"]
    holdout = [row for row in rows if row["split"] == "holdout"]
    if not train or not calibration:
        raise ValueError("training data must include non-empty train and calibration splits")
    if not holdout and not args.detached_holdout:
        raise ValueError(
            "training data must include a non-empty holdout split or declare --detached-holdout"
        )
    if holdout and args.detached_holdout:
        raise ValueError("--detached-holdout cannot be combined with holdout rows in the training input")
    if {row["label"] for row in train} != {0, 1} or {row["label"] for row in calibration} != {0, 1}:
        raise ValueError("train and calibration splits must each include positive and negative labels")

    selected_l2, cv_scores = choose_l2(train)
    intercept, coefficients = train_logistic(train, selected_l2)
    platt_a, platt_b = fit_platt(calibration, intercept, coefficients)
    calibration_probabilities = calibrated_probabilities(calibration, intercept, coefficients, platt_a, platt_b)
    thresholds = {
        "abstain": recall_threshold(calibration, calibration_probabilities, 0.995),
        "pathHint": recall_threshold(calibration, calibration_probabilities, 0.99),
        "content": recall_threshold(calibration, calibration_probabilities, 0.95),
    }
    thresholds["pathHint"] = max(thresholds["abstain"], thresholds["pathHint"])
    thresholds["content"] = max(thresholds["pathHint"], thresholds["content"])
    data_hash = hashlib.sha256(raw).hexdigest()
    manifest_name = f"{args.model_id}.training-manifest.json"
    artifact: dict[str, Any] = {
        "formatVersion": 1,
        "modelId": args.model_id,
        "featureSchemaVersion": SCHEMA_VERSION,
        "featureSchemaHash": schema_hash(),
        "orderedFeatures": FEATURES,
        "intercept": round(intercept, 12),
        "coefficients": rounded(coefficients),
        "calibration": {"kind": "platt", "a": round(platt_a, 12), "b": round(platt_b, 12)},
        "decisionThresholds": {key: round(value, 12) for key, value in thresholds.items()},
        "trainingDataHash": data_hash,
        "trainingManifest": manifest_name,
    }
    helper = Path(__file__).resolve().with_name("evidence-artifact-checksum.mjs")
    artifact["checksum"] = artifact_checksum(artifact, args.node, helper)
    manifest = {
        "schemaVersion": 1,
        "modelId": args.model_id,
        "publicDataOnly": True,
        "trainingDataHash": data_hash,
        "featureSchemaVersion": SCHEMA_VERSION,
        "featureSchemaHash": schema_hash(),
        "rows": {split: sum(row["split"] == split for row in rows) for split in ["train", "calibration", "holdout"]},
        "caseGroups": {split: len({row["caseGroupId"] for row in rows if row["split"] == split}) for split in ["train", "calibration", "holdout"]},
        "labelProvenance": dict(Counter(str(row.get("labelProvenance", "unknown")) for row in rows)),
        "dataOrigins": dict(Counter(str(row["dataOrigin"]) for row in rows)),
        "publicSources": sorted({str(row["publicSourceUrl"]) for row in rows}),
        "repositoryLineages": {
            split: sorted({str(row["repositoryLineageId"]) for row in rows if row["split"] == split})
            for split in ["train", "calibration", "holdout"]
        },
        "selectedL2": selected_l2,
        "crossValidationGroup": "repositoryLineageId",
        "crossValidationLogLoss": cv_scores,
        "calibration": evaluate(calibration, calibration_probabilities),
        "holdout": {
            "rows": len(holdout),
            "status": "detached_pending" if args.detached_holdout else "sealed_not_evaluated",
            "note": (
                "A separate lineage-disjoint holdout must be sealed and opened exactly once "
                "after this artifact is frozen."
                if args.detached_holdout
                else "Promotion metrics are computed only by the single-use sealed holdout campaign."
            ),
        },
        "decisionThresholds": artifact["decisionThresholds"],
        "artifactChecksum": artifact["checksum"],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    manifest_path = output.with_name(manifest_name)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    card_path = output.with_suffix(".MODEL_CARD.md")
    card_path.write_text(
        "\n".join([
            f"# {args.model_id}", "",
            "Local file-relevance logistic model for Kairn's repository evidence ranker.", "",
            f"- Artifact checksum: `{artifact['checksum']}`",
            f"- Training data hash: `{data_hash}`",
            f"- Feature schema: `{SCHEMA_VERSION}` / `{schema_hash()}`",
            f"- Public-data-only declaration: `true`",
            (
                "- Detached holdout: `pending` (must be sealed and opened exactly once after freeze)"
                if args.detached_holdout
                else f"- Sealed holdout rows (not evaluated during training): `{len(holdout)}`"
            ),
            f"- Cross-validation grouping: `repositoryLineageId`",
            "",
            "The model ranks repository files; deterministic Kairn policy still decides delivery and safety overrides.",
        ]) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "artifact": str(output),
        "manifest": str(manifest_path),
        "modelCard": str(card_path),
        "calibrationMetrics": manifest["calibration"],
        "holdoutStatus": manifest["holdout"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
