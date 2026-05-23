import { InteractionTrace } from './InteractionTrace';
import { ConfidenceLevel } from './ConfidenceLevel';

/** Per-model aggregated economics within a session. */
export interface ModelMetrics {
  readonly requestCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedCostUsd: number;
  readonly totalLatencyMs: number;
}

/** Per-workflow aggregated economics within a session. */
export interface WorkflowMetrics {
  readonly requestCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedCostUsd: number;
}

/**
 * Aggregated economics and observability metrics for a full session.
 * Recomputed incrementally after each InteractionTrace is appended.
 * Confidence is HEURISTIC — all cost/token values are estimates.
 */
export interface AggregateMetrics {
  readonly totalInteractions: number;
  readonly successCount: number;
  readonly cancelledCount: number;
  readonly errorCount: number;
  readonly retryCount: number;
  readonly escalationCount: number;
  readonly estimatedTotalInputTokens: number;
  readonly estimatedTotalOutputTokens: number;
  readonly estimatedTotalCostUsd: number;
  readonly estimatedBurnRatePerHour: number;
  readonly averageLatencyMs: number;
  readonly totalLatencyMs: number;
  readonly modelBreakdown: Readonly<Record<string, ModelMetrics>>;
  readonly workflowBreakdown: Readonly<Record<string, WorkflowMetrics>>;
  /** Estimated cost attributable to orchestration overhead */
  readonly orchestrationOverheadCostUsd: number;
  /** Estimated cost wasted on retries */
  readonly retryAmplificationCostUsd: number;
  /** Retry cost as % of total estimated cost */
  readonly retryCostPercentage: number;
  // ---- Semantic counters (populated when TraceClassifier is active) ---------
  /** Total span count across all interactions (internal operations) */
  readonly totalInternalOperations: number;
  /** Spans classified as hidden-inference across the session */
  readonly hiddenInferenceCount: number;
  /** Orchestration overhead cost as a fraction of total cost (0.0–1.0) */
  readonly orchestrationOverheadRatio: number;
  readonly confidence: ConfidenceLevel;
}

// ---------------------------------------------------------------------------
// Session lifecycle — not persisted in AggregateMetrics; ephemeral.
// ---------------------------------------------------------------------------

export type SessionLifecycleState =
  | 'started'
  | 'active'
  | 'idle'
  | 'resumed'
  | 'archived';

export interface SessionIndexEntry {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly interactionCount: number;
  readonly internalOperationCount: number;
  readonly estimatedTotalCostUsd: number;
  readonly workspaceName?: string;
}

/** Non-sensitive extension/environment metadata — safe to persist. */
export interface SessionMetadata {
  readonly vsCodeVersion?: string;
  readonly extensionVersion?: string;
  readonly workspaceName?: string;
  readonly os?: string;
}

/**
 * Authoritative persisted representation of one BurnSight observability session.
 *
 * This is the SINGLE SOURCE OF TRUTH for all analytics, UI, and dashboards.
 * The UI must NEVER depend on live log streams directly.
 *
 * Privacy guarantees:
 *   - Raw prompts and responses are NEVER stored.
 *   - Only hashes, lengths, tokens, models, workflows, and metrics persist.
 *
 * Storage: {globalStorageUri}/sessions/{sessionId}.json
 */
export interface SessionTelemetry {
  readonly sessionId: string;
  readonly provider: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly interactions: readonly InteractionTrace[];
  readonly aggregateMetrics: AggregateMetrics;
  readonly metadata: SessionMetadata;
  /** Schema version for migration \u2014 absence means v1 (legacy). Current: 2. */
  readonly schemaVersion?: number;
}
