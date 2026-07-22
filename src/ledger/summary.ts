// SPDX-License-Identifier: Apache-2.0

import type { SessionLedgerEvent, SessionLedgerSummary, TaskPhase } from "../types.js";
import { uniquePaths } from "../utils/collections.js";
import { buildSessionWorkingSet } from "./workingSet.js";

export function summarizeSessionLedger(sessionId: string, events: SessionLedgerEvent[]): SessionLedgerSummary {
  const recommendedFiles = uniquePaths(events.filter((event) => event.kind === "context_recommended").flatMap(eventFile));
  const shownFiles = uniquePaths(events.filter((event) => event.kind === "context_shown").flatMap(eventFile));
  const agentMentionedFiles = uniquePaths(events.filter((event) => event.kind === "agent_file_mentioned").flatMap(eventFile));
  const agentTouchedFiles = uniquePaths(events.filter((event) => event.kind === "agent_file_touched").flatMap(eventFile));
  const recommendedFilesUsed = recommendedFiles.filter((file) => agentMentionedFiles.includes(file) || agentTouchedFiles.includes(file));
  const touchedCounts = countValues(agentTouchedFilesFromEvents(events));
  const unresolvedFailures = Math.max(
    0,
    events.filter((event) => event.kind === "failure_seen").length -
      events.filter((event) => event.kind === "verification_passed").length
  );
  const currentPhase = inferCurrentPhase(events);
  const workingSet = buildSessionWorkingSet({ sessionId, events, currentPhase });

  return {
    sessionId,
    events: events.length,
    currentPhase,
    recommendedFiles,
    shownFiles,
    agentMentionedFiles,
    agentTouchedFiles,
    repeatedFilesAvoided: sumMetadataNumber(events, "repeatedFilesAvoided"),
    repeatedSnippetsAvoided: sumMetadataNumber(events, "repeatedSnippetsAvoided"),
    recommendedFilesUsed,
    repeatedlyTouchedFiles: [...touchedCounts.entries()].filter(([, count]) => count > 1).map(([file]) => file),
    unresolvedFailures,
    workingSet,
    recentEvents: events.slice(-20)
  };
}

export function inferCurrentPhase(events: SessionLedgerEvent[]): TaskPhase {
  const explicit = [...events].reverse().find((event) => event.kind === "phase_change" && typeof event.metadata.phase === "string");
  if (explicit && isTaskPhase(explicit.metadata.phase)) return explicit.metadata.phase;
  if ([...events].reverse().some((event) => event.kind === "failure_seen")) return "debugging";
  if ([...events].reverse().some((event) => event.kind === "verification_failed" || event.kind === "verification_passed" || event.kind === "test_run")) {
    return "verification";
  }
  if (events.some((event) => event.kind === "agent_file_touched" || event.kind === "diff_seen")) return "implementation";
  return "discovery";
}

function eventFile(event: SessionLedgerEvent): string[] {
  return event.filePath ? [event.filePath] : [];
}

function agentTouchedFilesFromEvents(events: SessionLedgerEvent[]): string[] {
  return events.filter((event) => event.kind === "agent_file_touched").flatMap(eventFile);
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sumMetadataNumber(events: SessionLedgerEvent[], key: string): number {
  return events.reduce((total, event) => total + (typeof event.metadata[key] === "number" ? event.metadata[key] : 0), 0);
}

function isTaskPhase(value: unknown): value is TaskPhase {
  return value === "discovery" || value === "implementation" || value === "debugging" || value === "verification" || value === "cleanup";
}
