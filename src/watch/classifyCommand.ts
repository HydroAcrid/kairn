import type { OutputKind } from "../types.js";

export function classifyObservedCommand(input: {
  command?: string | undefined;
  output?: string | undefined;
  eventName?: string | undefined;
}): OutputKind {
  const haystack = [input.command, input.output, input.eventName].filter(Boolean).join("\n").toLowerCase();

  if (/\b(tsc|typecheck|tsserver)\b/.test(haystack) || /\berror ts\d{4}\b/.test(haystack)) {
    return "typecheck";
  }

  if (/\b(eslint|biome|oxlint|lint)\b/.test(haystack)) {
    return "lint";
  }

  if (
    /\b(test|vitest|jest|mocha|playwright|cypress|ava|tap)\b/.test(haystack) ||
    /\b(test files|tests failed|tests? passed|expect\(|assertionerror)\b/.test(haystack)
  ) {
    return "test";
  }

  return "generic";
}
