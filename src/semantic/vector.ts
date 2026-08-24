// SPDX-License-Identifier: Apache-2.0

import { tokenizeLexical } from "./tokenize.js";

export const VECTOR_DIMENSIONS = 256;

export function embedText(input: string, dimensions = VECTOR_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const terms = tokenizeLexical(input);

  for (const term of terms) {
    const index = stableHash(term) % dimensions;
    vector[index] = (vector[index] ?? 0) + (term.length > 10 ? 1.25 : 1);
  }

  return normalizeVector(vector);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function serializeVector(vector: number[]): string {
  return JSON.stringify(vector.map((value) => Number(value.toFixed(6))));
}

export function deserializeVector(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : 0));
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
