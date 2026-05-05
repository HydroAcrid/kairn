export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToBudget(text: string, budget = 2000): string {
  const maxChars = Math.max(200, budget * 4);

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated to ~${budget} tokens]`;
}
