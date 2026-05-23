import { OverlaySnapshot, TelemetryState } from '../telemetry/types';

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
  totalRequests: number;
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