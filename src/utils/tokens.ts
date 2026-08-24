// SPDX-License-Identifier: Apache-2.0

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToBudget(text: string, budget = 2000): string {
  const suffix = `\n\n[truncated to ~${budget} tokens]`;
  const maxChars = Math.max(200, budget * 4 - suffix.length);

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}${suffix}`;
}
