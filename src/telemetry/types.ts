// ---------------------------------------------------------------------------
// Confidence classification — every derived metric carries one of these.
// REAL      = directly observed from a VSCode/Copilot API or log line with
//             no interpretation or approximation.
// ESTIMATED = calculated from REAL observations using a published formula
//             (e.g. tokens ≈ chars / 4; cost = tokens × published price).
// HEURISTIC = inferred through approximation when direct observation is
//             impossible (e.g. per-request input context size).
// ---------------------------------------------------------------------------
export enum ConfidenceLevel {
  REAL = 'REAL',
  ESTIMATED = 'ESTIMATED',
  HEURISTIC = 'HEURISTIC',
}

// ---------------------------------------------------------------------------
// Session activity — simplified to two states.
// ACTIVE transitions when a copilot.request event is observed.
// IDLE is the default when no requests have been seen recently.
// ---------------------------------------------------------------------------
export enum SessionState {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
}

export type CopilotLifecycleStage =
  | 'request_done'
  | 'model_seen'
  | 'latency_seen'
  | 'finish_reason_seen'
  | 'artifact_seen'
  | 'other';

// ---------------------------------------------------------------------------
// A single parsed event from the GitHub Copilot Chat output channel log.
// All fields that come directly from the log are REAL confidence.
// ---------------------------------------------------------------------------
export interface CopilotLogEvent {
  /** Epoch ms when we observed this log line — REAL */
  timestamp: number;
  /** Raw log line text (truncated to 200 chars) — REAL */
  raw: string;
  /** Model name extracted from log, e.g. "gpt-4o-mini-2024-07-18" — REAL */
  model?: string;
  /** Request latency in ms extracted from log, e.g. 1746 — REAL */
  latencyMs?: number;
  /** Copilot request ID extracted from log — REAL */
  requestId?: string;
  /** Finish reason extracted from log (stop, length, cancelled, …) — REAL */
  finishReason?: string;
  /** Session artifact ID (ccreq:xxxx.copilotmd) — REAL */
  sessionArtifact?: string;
  /** Provider metadata extracted from logs (openai, anthropic, google, etc.) — REAL */
  provider?: string;
  /** True when the line explicitly includes a request completion marker — REAL */
  requestDone: boolean;
  /** Number of visible characters in the parsed log line — REAL */
  observedChars: number;
  /** Source log file where this line was observed — REAL */
  sourceFile?: string;
  /** Classified lifecycle stage for internal tracking — REAL */
  stage: CopilotLifecycleStage;
  /** Fingerprint used to deduplicate repeated line emissions */
  fingerprint: string;
}

export interface RequestLifecycleState {
  requestId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  completedAt?: number;
  model?: string;
  latencyMs?: number;
  finishReason?: string;
  sessionArtifact?: string;
  provider?: string;
  accumulatedChars: number;
  seenRequestDone: boolean;
}

export interface DerivedMetric {
  id: string;
  label: string;
  confidence: ConfidenceLevel;
  value: number | string;
  formatted: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Accumulated session telemetry.  ALL numeric fields start at zero/null.
// No synthetic initial values.  Metrics only change when observable events
// (copilot.request) are ingested.
// ---------------------------------------------------------------------------
export interface TelemetryState {
  // ---- Directly observed (REAL) -----------------------------------------
  /** Epoch ms of first observed Copilot request; null until first event */
  sessionStartedAt: number | null;
  /** Epoch ms of most recent observed event */
  lastActivityAt: number;
  /** Number of completed Copilot requests observed this session */
  requestCount: number;
  /** Most recently observed model name */
  activeModel: string;
  /** Most recently observed provider name */
  activeProvider: string;
  /** All unique model names seen this session, in arrival order */
  modelHistory: string[];
  /** Per-model request counts: modelName → count */
  modelRequestCounts: Record<string, number>;
  /** Wall-clock latency in ms for each completed request */
  latencies: number[];
  /** Unique request IDs observed (used for deduplication) */
  requestIds: string[];
  /** Finish reason histogram: reason → count */
  finishReasons: Record<string, number>;
  /** Session artifacts observed (ccreq:*.copilotmd) */
  sessionArtifacts: string[];

  // ---- Lifecycle accumulators (REAL) -----------------------------------
  /** Latest lifecycle data per requestId */
  lifecycleByRequestId: Record<string, RequestLifecycleState>;
  /** Synthetic key counter for requests with no requestId in logs */
  orphanRequestCounter: number;

  // ---- Character accumulation (REAL) -----------------------------------
  /** Sum of observed characters across all relevant Copilot log lines */
  observedCharCount: number;
  /** Approximate context characters accumulated via artifacts + lifecycle */
  contextAccumulatedChars: number;

  // ---- ESTIMATED (tokens ≈ chars / 4) -----------------------------------
  // Architectural assumption: token count is approximated from observed
  // characters in Copilot runtime logs using tokens ≈ chars / 4.
  /** Total estimated output tokens across all requests */
  estimatedOutputTokens: number;
  /** Total estimated input (prompt) tokens across all requests */
  estimatedInputTokens: number;
  /** Total estimated tokens across all requests */
  estimatedTotalTokens: number;
  /** Estimated context accumulation in tokens (chars / 4 from context chars) */
  estimatedContextTokens: number;
  /** Per-model estimated token breakdown */
  modelTokens: Record<string, { input: number; output: number }>;

  // ---- ESTIMATED (cost = tokens × pricing table) -------------------------
  /** Total estimated session cost in USD */
  estimatedTotalCost: number;
  /** Per-model estimated cost in USD */
  modelCosts: Record<string, number>;
  /** Estimated burn rate in USD/hour — HEURISTIC (extrapolated from session) */
  estimatedBurnRatePerHour: number;

  // ---- Debug / audit ring buffer (REAL) ----------------------------------
  /** Most recent parsed log events, newest first; max 50 entries */
  recentEvents: CopilotLogEvent[];
}

// ---------------------------------------------------------------------------
// Runtime signals from VSCode editor observation.
// These DO NOT drive metrics — they are observational context only.
// ---------------------------------------------------------------------------
export type RuntimeSignalType =
  | 'probable_ai_insertion'
  | 'probable_manual_typing'
  | 'apply_changes'
  | 'large_diff'
  | 'rapid_delete';

export interface RuntimeSignal {
  type: RuntimeSignalType;
  /** 0.0–1.0 — HEURISTIC: based on insertion velocity and structure */
  confidence: number;
  source: string;
  timestamp: number;
  metadata?: {
    fileName?: string;
    insertedChars?: number;
    insertedLines?: number;
    deletedChars?: number;
    insertionVelocity?: number;
    preview?: string;
    command?: string;
  };
}

export interface RuntimeObservation {
  fileName: string;
  insertedChars: number;
  insertedLines: number;
  deletedChars: number;
  insertionTimestamp: number;
  insertionVelocity: number;
  /** HEURISTIC — inferred from velocity and code structure analysis */
  looksAiGenerated: boolean;
  /** 0.0–1.0 — HEURISTIC */
  confidence: number;
  previewSnippet: string;
}

// ---------------------------------------------------------------------------
// Overlay snapshot types — shape consumed by the webview.
// ---------------------------------------------------------------------------
export interface SessionCardSnapshot {
  id: string;
  kind: 'session';
  title: string;
  mainValue: string;
  progressLabel: string;
  progressValue: string;
  progressPct: number;
  rows: Array<{ label: string; value: string; accent?: 'cyan' | 'green' | 'orange' }>;
}

export interface TableCardSnapshot {
  id: string;
  kind: 'table';
  title: string;
  columns: string[];
  rows: string[][];
}

export interface ListCardSnapshot {
  id: string;
  kind: 'list';
  title: string;
  tone: 'neutral' | 'danger' | 'ok';
  rows: Array<{ label: string; value: string; accent?: 'cyan' | 'green' | 'orange' }>;
  footerLabel?: string;
  footerValue?: string;
}

export type OverlayCardSnapshot =
  | SessionCardSnapshot
  | TableCardSnapshot
  | ListCardSnapshot;

// ---------------------------------------------------------------------------
// Debug info shown in the debug panel — all raw/observable values.
// ---------------------------------------------------------------------------
export interface OverlayDebugSnapshot {
  /** Whether debug mode is enabled */
  enabled: boolean;
  /** Currently active model name — REAL */
  activeModel: string;
  /** Total request count this session — REAL */
  requestCount: string;
  /** Average request latency — REAL */
  avgLatencyMs: string;
  /** Raw text of the most recent log event — REAL */
  lastEventRaw: string;
  /** Ring buffer of recent raw log lines for inspection — REAL */
  recentEvents: string[];
  /** Most recent runtime signal classification from RuntimeInspector — HEURISTIC */
  lastRuntimeSignal: string;
  /** Confidence of latest runtime signal classification — HEURISTIC */
  lastRuntimeSignalConfidence: string;
  /** Most recent Copilot-related command observed — REAL */
  lastCopilotCommand: string;
}

export interface OverlaySnapshot {
  title: string;
  isLive: boolean;
  version: string;
  runtimeState: SessionState;
  runtimeLabel: string;
  debug: OverlayDebugSnapshot;
  metrics: DerivedMetric[];
  cards: OverlayCardSnapshot[];
}

// ---------------------------------------------------------------------------
// Event bus contract.
// ---------------------------------------------------------------------------
export interface BurnSightEvents {
  /** Fired by CopilotLogParser when a request lifecycle event is parsed — REAL */
  'copilot.request': CopilotLogEvent;
  /** Fired by TelemetryService on activity state transition */
  'session.stateChanged': {
    previous: SessionState;
    current: SessionState;
  };
  /** Fired by RuntimeInspector on raw text change — observational context only */
  'runtime.observation': RuntimeObservation;
  /** Fired by RuntimeInspector with classified signal — observational context only */
  'runtime.signal': RuntimeSignal;
  /** Fired by RuntimeInspector on command execution */
  'runtime.command': {
    command: string;
    timestamp: number;
    isCopilotRelated: boolean;
  };
  /** Fired by TelemetryService after each state update */
  'telemetry.snapshot': OverlaySnapshot;
  /** Fired by TelemetryService after telemetry state mutation */
  'telemetry.updated': {
    event: CopilotLogEvent;
    state: TelemetryState;
    snapshot: OverlaySnapshot;
  };
  /** Fired to push payload to overlay webview consumers */
  'ui.webviewUpdate': OverlaySnapshot;
  /** Fired to push payload to status bar consumers */
  'statusbar.update': OverlaySnapshot;
}
