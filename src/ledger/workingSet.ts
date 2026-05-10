import type {
  SessionLedgerEvent,
  SessionWorkingSet,
  SessionWorkingSetInvariant,
  SessionWorkingSetNextRead,
  SessionWorkingSetSignal,
  TaskPhase
} from "../types.js";
import { uniquePaths } from "../utils/collections.js";

export function buildSessionWorkingSet(input: {
  sessionId: string;
  events: SessionLedgerEvent[];
  currentPhase: TaskPhase;
}): SessionWorkingSet {
  const events = input.events;
  const recommendedFiles = uniquePaths(events.filter((event) => event.kind === "context_recommended").flatMap(eventFile));
  const shownFiles = uniquePaths(events.filter((event) => event.kind === "context_shown").flatMap(eventFile));
  const mentionedFiles = uniquePaths(events.filter((event) => event.kind === "agent_file_mentioned").flatMap(eventFile));
  const touchedFiles = events.filter((event) => event.kind === "agent_file_touched").flatMap(eventFile);
  const recentlyTouchedFiles = uniquePaths(touchedFiles.slice(-8));
  const usedFiles = uniquePaths([...mentionedFiles, ...touchedFiles]);
  const ignoredRecommendedFiles = recommendedFiles.filter((file) => !usedFiles.includes(file));
  const failureEvents = events.filter((event) => event.kind === "failure_seen");
  const verificationPassedEvents = events.filter((event) => event.kind === "verification_passed");
  const lastFailure = signalFromEvent(failureEvents.at(-1));
  const lastPassingVerification = signalFromEvent(verificationPassedEvents.at(-1));
  const unresolvedFailure = Boolean(
    lastFailure &&
      (!lastPassingVerification || Date.parse(lastFailure.createdAt) > Date.parse(lastPassingVerification.createdAt))
  );
  const contextWasActivelyShown = shownFiles.length > 0;
  const ignoreStaleRecommendations = !contextWasActivelyShown || Boolean(lastPassingVerification && !unresolvedFailure);
  const currentInvariant = latestInvariant(events);
  const ruledOutFiles = uniquePaths(
    events
      .filter((event) => event.kind === "context_shown" && event.metadata.policyReason === "repeated_context_suppressed")
      .flatMap(eventFile)
  );
  const staleFiles = uniquePaths(
    shownFiles.filter((file) => {
      const lastShown = lastEventForFile(events, "context_shown", file);
      const lastTouched = lastEventForFile(events, "agent_file_touched", file);
      return Boolean(lastShown && lastTouched && Date.parse(lastTouched.createdAt) > Date.parse(lastShown.createdAt));
    })
  );
  const activeFiles = uniquePaths([
    ...recentlyTouchedFiles,
    ...(lastFailure?.filePath ? [lastFailure.filePath] : []),
    ...(lastPassingVerification?.filePath ? [lastPassingVerification.filePath] : []),
    ...(currentInvariant?.filePath ? [currentInvariant.filePath] : []),
    ...usedFiles.slice(-6),
    ...shownFiles.slice(-4)
  ]).filter((file) => !ruledOutFiles.includes(file));
  const nextSmallestUsefulRead = chooseNextRead({
    lastFailure,
    unresolvedFailure,
    staleFiles,
    ignoredRecommendedFiles: ignoreStaleRecommendations ? [] : ignoredRecommendedFiles,
    activeFiles,
    shownFiles
  });
  const openRisks = buildOpenRisks({
    ignoredRecommendedFiles: ignoreStaleRecommendations ? [] : ignoredRecommendedFiles,
    lastFailure,
    lastPassingVerification,
    unresolvedFailure,
    staleFiles
  });

  return {
    sessionId: input.sessionId,
    currentPhase: input.currentPhase,
    activeFiles,
    recentlyTouchedFiles,
    shownFiles,
    ignoredRecommendedFiles,
    ruledOutFiles,
    staleFiles,
    ...(currentInvariant ? { currentInvariant } : {}),
    ...(lastFailure ? { lastFailure } : {}),
    ...(lastPassingVerification ? { lastPassingVerification } : {}),
    ...(nextSmallestUsefulRead ? { nextSmallestUsefulRead } : {}),
    openRisks
  };
}

function chooseNextRead(input: {
  lastFailure?: SessionWorkingSetSignal | undefined;
  unresolvedFailure: boolean;
  staleFiles: string[];
  ignoredRecommendedFiles: string[];
  activeFiles: string[];
  shownFiles: string[];
}): SessionWorkingSetNextRead | undefined {
  if (input.unresolvedFailure && input.lastFailure?.filePath) {
    return {
      filePath: input.lastFailure.filePath,
      reason: "latest failure references this file",
      source: "failure"
    };
  }
  if (input.staleFiles[0]) {
    return {
      filePath: input.staleFiles[0],
      reason: "file changed after Kairn last showed it",
      source: "changed_file"
    };
  }
  const ignored = input.ignoredRecommendedFiles.find((file) => !input.shownFiles.includes(file));
  if (ignored) {
    return {
      filePath: ignored,
      reason: "Kairn recommended this file earlier but the agent has not used it",
      source: "ignored_recommendation"
    };
  }
  const active = input.activeFiles.find((file) => !input.shownFiles.includes(file));
  return active
    ? {
        filePath: active,
        reason: "active session file has not been shown yet",
        source: "active_file"
      }
    : undefined;
}

function buildOpenRisks(input: {
  ignoredRecommendedFiles: string[];
  lastFailure?: SessionWorkingSetSignal | undefined;
  lastPassingVerification?: SessionWorkingSetSignal | undefined;
  unresolvedFailure: boolean;
  staleFiles: string[];
}): string[] {
  const risks: string[] = [];
  if (input.ignoredRecommendedFiles.length > 0) {
    risks.push(`${input.ignoredRecommendedFiles.length} recommended file(s) have not been used by the agent`);
  }
  if (input.lastFailure && input.unresolvedFailure) {
    risks.push("latest failure has not been followed by a passing verification");
  }
  if (input.staleFiles.length > 0) {
    risks.push(`${input.staleFiles.length} shown file(s) changed after being shown`);
  }
  return risks;
}

function latestInvariant(events: SessionLedgerEvent[]): SessionWorkingSetInvariant | undefined {
  for (const event of [...events].reverse()) {
    const invariant = event.metadata.invariant;
    const statement = invariantStatement(invariant) ?? invariantStatement(event.metadata.invariantStatement);
    if (!statement) continue;
    const confidence = invariantConfidence(invariant);
    return {
      statement,
      ...(event.filePath ? { filePath: event.filePath } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(event.id !== undefined ? { sourceEventId: event.id } : {})
    };
  }
  return undefined;
}

function invariantStatement(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const statement = (value as { statement?: unknown }).statement;
    return typeof statement === "string" && statement.trim().length > 0 ? statement.trim() : undefined;
  }
  return undefined;
}

function invariantConfidence(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const confidence = (value as { confidence?: unknown }).confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : undefined;
}

function signalFromEvent(event: SessionLedgerEvent | undefined): SessionWorkingSetSignal | undefined {
  if (!event) return undefined;
  return {
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.filePath ? { filePath: event.filePath } : {}),
    summary: event.summary,
    createdAt: event.createdAt
  };
}

function lastEventForFile(events: SessionLedgerEvent[], kind: SessionLedgerEvent["kind"], filePath: string): SessionLedgerEvent | undefined {
  return [...events].reverse().find((event) => event.kind === kind && event.filePath === filePath);
}

function eventFile(event: SessionLedgerEvent): string[] {
  return event.filePath ? [event.filePath] : [];
}
