/**
 * Provider-agnostic normalized signal emitted by every ProviderAdapter.
 *
 * Adapters translate raw provider-specific events (log lines, IPC, API
 * callbacks) into this canonical shape.  The CorrelationEngine consumes
 * RawSignals and builds InteractionTraces.
 *
 * Adapters MUST NOT generate metrics.  A RawSignal is a structural fact,
 * not an interpretation.
 */
export type RawSignalType =
  | 'request-start'
  | 'request-end'
  | 'model-detected'
  | 'tool-call'
  | 'retry'
  | 'escalation'
  | 'editor-change';

export interface RawSignal {
  /** Unique ID for this signal instance (adapter-scoped) */
  readonly signalId: string;
  /** Provider identifier — e.g. 'github-copilot', 'claude-code' */
  readonly source: string;
  /** Epoch ms when this signal was observed */
  readonly timestamp: number;
  /** Semantic classification of this signal */
  readonly type: RawSignalType;
  /** Provider request/trace correlation ID */
  readonly requestId?: string;
  /** VS Code session ID when available */
  readonly sessionId?: string;
  /** Primary model name observed */
  readonly model?: string;
  /** Full model chain for escalation paths — e.g. ['gpt-4o-mini', 'gpt-5.3-codex'] */
  readonly modelChain?: string[];
  /** Request latency in ms (populated on request-end only) */
  readonly latencyMs?: number;
  /** Feature/workflow label — e.g. 'chat/edit', 'panel/editAgent' */
  readonly feature?: string;
  /** Request outcome status */
  readonly status?: 'success' | 'cancelled' | 'error' | string;
  /** Observed retry count within this request */
  readonly retryCount?: number;
  /** Number of model escalation hops */
  readonly escalationCount?: number;
  /** Raw log line used for economics heuristics — NOT persisted */
  readonly rawLine?: string;
  /** Whether this request was classified as a retry at the provider level */
  readonly isRetry?: boolean;
  /** Adapter-specific metadata — NOT persisted in SessionTelemetry */
  readonly metadata?: Record<string, unknown>;
}
