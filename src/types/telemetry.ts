export type TelemetryDestination = "supabase";

export type TelemetryConfig = {
  enabled: boolean;
  destination?: TelemetryDestination | undefined;
  endpoint?: string | undefined;
  installationId?: string | undefined;
  repoSalt?: string | undefined;
  updatedAt?: string | undefined;
};

export type TelemetryStatus = {
  enabled: boolean;
  destination?: TelemetryDestination;
  endpointConfigured: boolean;
  installationId?: string;
  queueLength: number;
  queuePath: string;
  configPath: string;
};

export type TelemetryPayload = {
  schemaVersion: 1;
  generatedAt: string;
  installationId: string;
  kairnVersion: string;
  repo: {
    fileCountBucket: string;
    stateSizeBucket: string;
    languageMix: Record<string, number>;
    extensionCounts: Record<string, number>;
    roleCounts: Record<string, number>;
  };
  sessions: {
    count: number;
    sampled: number;
  };
  decisions: {
    emit: number;
    shrink: number;
    suppress: number;
  };
  assistance: {
    active: number;
    passiveSuppressed: number;
    none: number;
    validAssist: number;
    overAssist: number;
    missedOpportunity: number;
    harmfulAssist: number;
  };
  tokens: {
    estimatedBaseline: number;
    estimatedOutput: number;
    estimatedSaved: number;
    activeEstimatedSaved: number;
    passiveEstimatedSaved: number;
    observedTotal?: number;
  };
  hooks: {
    invocations: number;
    failures: number;
    daemonHits: number;
    daemonMisses: number;
    averageLatencyMs?: number;
  };
  mcp: {
    calls: number;
    returnedSourceFiles: number;
    returnedTestFiles: number;
    returnedNoiseFiles: number;
  };
  ledger: {
    events: number;
    repeatedFilesAvoided: number;
    repeatedSnippetsAvoided: number;
    unresolvedFailures: number;
  };
  quality: {
    benchmarkPasses: number;
    benchmarkFailures: number;
  };
  fileSignals: {
    hashedFileIds: string[];
  };
};

export type TelemetryQueueEntry = {
  id: string;
  createdAt: string;
  payload: TelemetryPayload;
  attempts: number;
  lastError?: string;
};

export type TelemetryFlushResult = {
  enabled: boolean;
  dryRun: boolean;
  endpoint?: string;
  attempted: number;
  sent: number;
  retained: number;
  failures: string[];
};

export type DiagnosticExport = {
  schemaVersion: 1;
  generatedAt: string;
  root: {
    redacted: true;
  };
  telemetry: TelemetryStatus;
  doctor?: unknown;
  betaReport: unknown;
  payloadPreview: TelemetryPayload;
};
