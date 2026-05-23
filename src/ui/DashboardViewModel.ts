import { OverlaySnapshot, RuntimeDebugState, TelemetryState } from '../telemetry/types';
import { SessionTelemetry } from '../domain/SessionTelemetry';

export interface DashboardModelSpendRow {
  model: string;
  requests: number;
  spendUsd: number;
}

export interface DashboardWorkflowSpendRow {
  workflow: string;
  requests: number;
  spendUsd: number;
}

export interface DashboardViewModel {
  version: string;
  runtimeLabel: string;
  isLive: boolean;
  debugEnabled: boolean;
  // --- Legacy field (kept for overlay compatibility)
  totalRequests: number;
  // --- Semantic counters (Phase 2: Session Intelligence)
  /** Number of distinct user interactions this session */
  interactions: number;
  /** Total internal operations (spans) across all interactions */
  internalOperations: number;
  /** Orchestration overhead as a percentage 0–100 */
  orchestrationOverheadPct: number;
  /** Number of hidden-inference spans across this session */
  hiddenInferenceCount: number;
  /** The workflow responsible for most cost this session */
  dominantWorkflow: string;
  /** Confidence label for cost estimates */
  confidenceLabel: string;
  estimatedSessionCostUsd: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  averageLatencyMs: number;
  retries: number;
  escalations: number;
  activeModels: string[];
  activeModel: string;
  requestsByModel: Record<string, number>;
  spendByModel: Record<string, number>;
  requestsByWorkflow: Record<string, number>;
  spendByWorkflow: Record<string, number>;
  modelSpendRows: DashboardModelSpendRow[];
  workflowSpendRows: DashboardWorkflowSpendRow[];
  mostUsedModel: string;
  mostExpensiveModel: string;
  topWorkflow: string;
  retryCostSharePct: number;
  requestDistribution: string;
  sessionArtifacts: number;
  averageRequestCostUsd: number;
  estimatedBurnRateUsdPerHour: number;
  sessionDurationMs: number;
  updatedAt: number;
  debug: {
    lastRuntimeSignal: string;
    lastRuntimeSignalConfidence: string;
    lastCopilotCommand: string;
    lastEventRaw: string;
    recentEvents: string[];
  };
}

export function createDashboardViewModel(input: {
  state: TelemetryState;
  snapshot: OverlaySnapshot;
  updatedAt: number;
}): DashboardViewModel {
  const { state, snapshot, updatedAt } = input;

  const modelSpendRows = Object.entries(state.modelCosts)
    .sort((left, right) => right[1] - left[1])
    .map(([model, spendUsd]) => ({
      model,
      requests: state.modelRequestCounts[model] ?? 0,
      spendUsd,
    }));

  const workflowSpendRows = Object.entries(state.workflowCosts)
    .sort((left, right) => right[1] - left[1])
    .map(([workflow, spendUsd]) => ({
      workflow,
      requests: state.requestsByFeature[workflow] ?? 0,
      spendUsd,
    }));

  return {
    version: snapshot.version,
    runtimeLabel: snapshot.runtimeLabel,
    isLive: snapshot.isLive,
    debugEnabled: snapshot.debug.enabled,
    totalRequests: state.requestCount,
    estimatedSessionCostUsd: state.estimatedTotalCost,
    estimatedInputTokens: state.estimatedInputTokens,
    estimatedOutputTokens: state.estimatedOutputTokens,
    estimatedTotalTokens: state.estimatedTotalTokens,
    averageLatencyMs: state.averageLatencyMs,
    retries: state.retryRequests,
    escalations: state.escalationCount,
    activeModels: state.modelHistory.slice(),
    activeModel: state.activeModel || 'none',
    requestsByModel: { ...state.modelRequestCounts },
    spendByModel: { ...state.modelCosts },
    requestsByWorkflow: { ...state.requestsByFeature },
    spendByWorkflow: { ...state.workflowCosts },
    modelSpendRows,
    workflowSpendRows,
    mostUsedModel: getMostUsed(state.modelRequestCounts),
    mostExpensiveModel: getMostUsed(state.modelCosts),
    topWorkflow: getMostUsed(state.requestsByFeature),
    retryCostSharePct: Math.round(state.retryCostPercentage),
    requestDistribution: formatDistribution(state.modelRequestCounts, state.requestCount),
    sessionArtifacts: state.sessionArtifacts.length,
    averageRequestCostUsd: state.requestCount > 0 ? state.estimatedTotalCost / state.requestCount : 0,
    estimatedBurnRateUsdPerHour: state.estimatedBurnRatePerHour,
    sessionDurationMs:
      state.sessionStartedAt !== null ? Math.max(0, updatedAt - state.sessionStartedAt) : 0,
    updatedAt,
    // Semantic Phase 2 fields — not available in legacy path
    interactions: state.requestCount,
    internalOperations: state.requestCount,
    orchestrationOverheadPct: 0,
    hiddenInferenceCount: 0,
    dominantWorkflow: getMostUsed(state.requestsByFeature),
    confidenceLabel: 'Estimated',
    debug: {
      lastRuntimeSignal: snapshot.debug.lastRuntimeSignal,
      lastRuntimeSignalConfidence: snapshot.debug.lastRuntimeSignalConfidence,
      lastCopilotCommand: snapshot.debug.lastCopilotCommand,
      lastEventRaw: snapshot.debug.lastEventRaw,
      recentEvents: snapshot.debug.recentEvents,
    },
  };
}

function getMostUsed(counts: Record<string, number>): string {
  const sorted = Object.entries(counts).sort((left, right) => right[1] - left[1]);
  return sorted[0]?.[0] ?? 'none';
}

function formatDistribution(counts: Record<string, number>, totalRequests: number): string {
  if (totalRequests <= 0) {
    return 'none';
  }

  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([model, count]) => `${model}:${Math.round((count / totalRequests) * 100)}%`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// v3 domain-based factory — primary path for arch v3 pipeline.
// Derives DashboardViewModel from SessionTelemetry + RuntimeDebugState without
// touching raw logs.
// ---------------------------------------------------------------------------

/**
 * Build a DashboardViewModel from new domain types.
 * This is the primary factory for the v3 architecture.
 */
export function createDashboardViewModelFromSession(
  session: SessionTelemetry,
  runtime: RuntimeDebugState,
): DashboardViewModel {
  const agg = session.aggregateMetrics;
  const now = Date.now();

  const modelSpendRows: DashboardModelSpendRow[] = Object.entries(agg.modelBreakdown)
    .sort(([, a], [, b]) => b.estimatedCostUsd - a.estimatedCostUsd)
    .map(([model, m]) => ({
      model,
      requests: m.requestCount,
      spendUsd: m.estimatedCostUsd,
    }));

  const workflowSpendRows: DashboardWorkflowSpendRow[] = Object.entries(
    agg.workflowBreakdown,
  )
    .sort(([, a], [, b]) => b.estimatedCostUsd - a.estimatedCostUsd)
    .map(([workflow, w]) => ({
      workflow,
      requests: w.requestCount,
      spendUsd: w.estimatedCostUsd,
    }));

  const requestsByModel = Object.fromEntries(
    Object.entries(agg.modelBreakdown).map(([k, v]) => [k, v.requestCount]),
  );
  const spendByModel = Object.fromEntries(
    Object.entries(agg.modelBreakdown).map(([k, v]) => [k, v.estimatedCostUsd]),
  );
  const requestsByWorkflow = Object.fromEntries(
    Object.entries(agg.workflowBreakdown).map(([k, v]) => [k, v.requestCount]),
  );
  const spendByWorkflow = Object.fromEntries(
    Object.entries(agg.workflowBreakdown).map(([k, v]) => [k, v.estimatedCostUsd]),
  );

  const mostUsedModel = getMostUsed(requestsByModel);
  const mostExpensiveModel = getMostUsed(spendByModel);
  const topWorkflow = getMostUsed(requestsByWorkflow);

  return {
    version: 'v3',
    runtimeLabel: runtime.label,
    isLive: runtime.isLive,
    debugEnabled: runtime.debugEnabled,
    totalRequests: agg.totalInteractions,
    estimatedSessionCostUsd: agg.estimatedTotalCostUsd,
    estimatedInputTokens: agg.estimatedTotalInputTokens,
    estimatedOutputTokens: agg.estimatedTotalOutputTokens,
    estimatedTotalTokens: agg.estimatedTotalInputTokens + agg.estimatedTotalOutputTokens,
    averageLatencyMs: agg.averageLatencyMs,
    retries: agg.retryCount,
    escalations: agg.escalationCount,
    activeModels: Object.keys(agg.modelBreakdown),
    activeModel: runtime.activeModel || mostUsedModel || 'none',
    requestsByModel,
    spendByModel,
    requestsByWorkflow,
    spendByWorkflow,
    modelSpendRows,
    workflowSpendRows,
    mostUsedModel,
    mostExpensiveModel,
    topWorkflow,
    retryCostSharePct: Math.round(agg.retryCostPercentage),
    requestDistribution: formatDistribution(requestsByModel, agg.totalInteractions),
    sessionArtifacts: 0,
    averageRequestCostUsd:
      agg.totalInteractions > 0
        ? agg.estimatedTotalCostUsd / agg.totalInteractions
        : 0,
    estimatedBurnRateUsdPerHour: agg.estimatedBurnRatePerHour,
    sessionDurationMs: Math.max(0, now - session.startedAt),
    updatedAt: runtime.updatedAt,
    // Semantic Phase 2 fields
    interactions: agg.totalInteractions,
    internalOperations: agg.totalInternalOperations,
    orchestrationOverheadPct: Math.round(agg.orchestrationOverheadRatio * 100),
    hiddenInferenceCount: agg.hiddenInferenceCount,
    dominantWorkflow: topWorkflow || 'unknown',
    confidenceLabel: String(agg.confidence),
    debug: {
      lastRuntimeSignal: runtime.lastRuntimeSignal,
      lastRuntimeSignalConfidence: runtime.lastRuntimeSignalConfidence,
      lastCopilotCommand: runtime.lastCopilotCommand,
      lastEventRaw: runtime.lastEventRaw,
      recentEvents: runtime.recentEvents,
    },
  };
}