import type { ContextPrime, ContextResponse, OutputKind } from "./context.js";
import type { TaskSession } from "./runtime.js";

export type WatchEventSource = "watch" | "generic" | "claude" | "codex";

export type WatchEventKind = "file_change" | "diff_change" | "command" | "tool" | "session" | "hook" | "failure";

export type WatchEventRecord = {
  id?: number;
  sessionId: string;
  source: WatchEventSource;
  kind: WatchEventKind;
  eventName: string;
  toolName?: string;
  command?: string;
  files: string[];
  exitCode?: number;
  summary: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type HostSessionLinkRecord = {
  source: WatchEventSource;
  rootPath: string;
  hostSessionId: string;
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
};

export type NormalizedHookEvent = {
  source: WatchEventSource;
  eventName: string;
  kind: WatchEventKind;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  command?: string;
  output?: string;
  exitCode?: number;
  files: string[];
  cwd?: string;
  timestamp?: string;
  hostSessionId?: string;
  metadata: Record<string, unknown>;
};

export type WatchRecommendation = {
  summary: string;
  files: string[];
  suggestedNextContext: string[];
  warnings: string[];
  content?: string;
};

export type FailureContext = {
  session: TaskSession;
  type: OutputKind;
  content: string;
  files: string[];
  failureFiles: string[];
  relatedFiles: string[];
  testFiles: string[];
  changedFiles: string[];
  tokenEstimate: number;
  warnings: string[];
};

export type WatchSnapshot = {
  sessionId: string;
  rootPath: string;
  changedFiles: string[];
  indexedFiles: number;
  watchEvents: WatchEventRecord[];
  recommendations: WatchRecommendation[];
  createdAt: string;
};

export type HookHandlingResult = {
  session: TaskSession;
  event: WatchEventRecord;
  recommendation?: WatchRecommendation;
  response?: ContextResponse;
  failureContext?: FailureContext;
  prime?: ContextPrime;
};
