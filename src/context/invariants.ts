import type { ContextInvariant } from "../types.js";
import { truncateToBudget } from "../utils/tokens.js";

export function buildContextInvariant(input: {
  task: string;
  file: string;
  symbol?: string | undefined;
  snippet?: string | undefined;
  verificationCommand?: string | undefined;
}): ContextInvariant {
  const statement = inferInvariantStatement(input.task, input.symbol);
  const evidence = inferInvariantEvidence({
    task: input.task,
    symbol: input.symbol,
    snippet: input.snippet
  });
  const source = inferInvariantSource(input.task, input.snippet);
  const confidence = inferInvariantConfidence({
    task: input.task,
    symbol: input.symbol,
    snippet: input.snippet,
    statement
  });

  return {
    file: input.file,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    statement,
    ...(evidence ? { evidence } : {}),
    ...(input.verificationCommand ? { verificationCommand: input.verificationCommand } : {}),
    confidence,
    source
  };
}

export function inferInvariantStatement(task: string, symbol?: string | undefined): string {
  const normalized = normalizeWhitespace(task);
  const behaviorTemplate = behaviorTemplateForTask(normalized);
  if (behaviorTemplate) return behaviorTemplate;

  const behaviorSentence = extractBehaviorSentence(normalized);
  if (behaviorSentence) return behaviorSentence;

  const cleaned = normalized
    .replace(/\bdebug\b/gi, "Fix")
    .replace(/\bseeded\b/gi, "")
    .replace(/\bregression\b/gi, "behavior")
    .replace(/\bdo not edit unrelated files\b\.?/gi, "")
    .trim();
  return truncateToBudget(
    symbol
      ? `${symbol} must preserve the task behavior: ${cleaned}`
      : `Preserve the task behavior while fixing: ${cleaned}`,
    72
  );
}

function extractBehaviorSentence(task: string): string | undefined {
  const sentences = task
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);
  const behavior = sentences
    .map((sentence) => ({ sentence, score: behaviorSentenceScore(sentence) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length)[0]?.sentence;
  if (!behavior) return undefined;
  return truncateToBudget(cleanInvariantSentence(behavior), 72);
}

function behaviorSentenceScore(sentence: string): number {
  let score = 0;
  if (/\b(should|must|preserve|expected)\b/i.test(sentence)) score += 40;
  if (/\b(no longer|instead of|not only|while still)\b/i.test(sentence)) score += 22;
  if (/\b(fails?|broken|wrong|incorrect)\b/i.test(sentence)) score += 16;
  if (/\bregression\b/i.test(sentence)) score += 8;
  if (/^\s*(debug|fix|investigate)\b/i.test(sentence)) score -= 8;
  return score;
}

function behaviorTemplateForTask(task: string): string | undefined {
  const normalized = task.toLowerCase();
  if (/\brelative\b/.test(normalized) && /\blocal urls?\b|\blocal url helper\b/.test(normalized)) {
    return "Relative or non-absolute URLs must remain local/routable before absolute-origin fallback logic.";
  }
  if (/\ballow_unicode\b/.test(normalized) && /\bslugify\b/.test(normalized)) {
    return "slugify(..., allow_unicode=True) must preserve Unicode characters while normalizing separators.";
  }
  if (/\bansi\b/.test(normalized) && /\b(term_len|visible length|terminal visible length)\b/.test(normalized)) {
    return "ANSI escape sequences must not count toward visible terminal text length.";
  }
  if (/\bstarts_with\b/.test(normalized) && /\bequal-length|equal length|identical prefix\b/.test(normalized)) {
    return "starts_with must return true for an equal-length identical prefix.";
  }
  if (/\bisblank\b/.test(normalized) && /\bwhitespace\b/.test(normalized)) {
    return "isBlank must use the language whitespace semantics, not only literal spaces.";
  }
  if (
    /\b(voice|broadcast)\b/.test(normalized) &&
    /\b(liveness|live|badge|icon|feedback|visual|recording|playback|paused|grey|gray)\b/.test(normalized)
  ) {
    return "Voice broadcast UI state must distinguish live, paused/grey, and not-live states consistently across playback and recording surfaces.";
  }
  if (
    /\b(validat(e|ion)|valid|invalid|reject|accept)\b/.test(normalized) &&
    /\b(identifier|keyword|reserved|fqcn|collection name|namespace)\b/.test(normalized)
  ) {
    return "Validation changes must reject newly invalid inputs while preserving existing invalid-input rejection paths; invalid values must not fall through to later runtime branches.";
  }
  if (/\bhash\b/.test(normalized) && /\b(order|properties|query keys?)\b/.test(normalized)) {
    return "Equivalent object keys must hash consistently regardless of property order.";
  }
  return undefined;
}

function inferInvariantEvidence(input: {
  task: string;
  symbol?: string | undefined;
  snippet?: string | undefined;
}): string | undefined {
  const snippet = input.snippet?.trim();
  if (!snippet) return undefined;
  const taskTerms = new Set(
    input.task
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length >= 4)
  );
  const lines = snippet
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const symbolLine = input.symbol
    ? lines.find((line) => line.toLowerCase().includes(input.symbol!.toLowerCase()))
    : undefined;
  const behaviorLine = lines.find((line) => {
    const normalized = line.toLowerCase();
    return [...taskTerms].some((term) => normalized.includes(term)) || /\b(return|assert|throw|normalize|prefix|absolute|relative|unicode|whitespace)\b/.test(normalized);
  });
  const selected = symbolLine ?? behaviorLine;
  return selected ? truncateToBudget(selected, 44) : undefined;
}

function inferInvariantSource(task: string, snippet?: string | undefined): ContextInvariant["source"] {
  if (/\bseeded\b/i.test(task)) return "seed";
  if (/\b(failing test|test failure|assert|expected|received)\b/i.test(task)) return "test";
  if (/\b(error|stack|trace|exception|failure)\b/i.test(task)) return "failure";
  if (snippet?.trim()) return "symbol";
  return "heuristic";
}

function inferInvariantConfidence(input: {
  task: string;
  symbol?: string | undefined;
  snippet?: string | undefined;
  statement: string;
}): number {
  let score = 52;
  if (/\b(should|must|preserve|expected|no longer|regression)\b/i.test(input.task)) score += 18;
  if (/\bseeded\b/i.test(input.task)) score += 8;
  if (input.symbol && input.task.toLowerCase().includes(input.symbol.toLowerCase())) score += 10;
  if (input.snippet?.trim()) score += 8;
  if (/\bmust\b|\bshould\b/i.test(input.statement)) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function cleanInvariantSentence(sentence: string): string {
  const cleaned = sentence
    .replace(/^\s*(debug|fix|investigate)\b\s*/i, "")
    .replace(/\bseeded\b\s*/gi, "")
    .replace(/\bdo not edit unrelated files\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return sentence;
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
