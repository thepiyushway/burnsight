export interface AIRequestEvent {
  timestamp: number;
  provider: 'github-copilot';
  requestId: string;
  status: 'success' | 'cancelled' | 'error' | string;
  model: string;
  modelChain?: string[];
  routedFromModel?: string;
  hasEscalation?: boolean;
  escalationCount?: number;
  latencyMs: number;
  feature: string;
  isRetry?: boolean;
  retryCount?: number;
  rawLine: string;
  sourceFile: string;
  fileOffset: number;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.3-codex': {
    inputPer1M: 15,
    outputPer1M: 60,
  },
  'gpt-4o-mini-2024-07-18': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
  },
};

export interface AIEconomicEvent extends AIRequestEvent {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  retryAmplification: number;
  escalationAmplification: number;
  orchestrationAmplification: number;
  retryAmplifiedCostUsd: number;
  pricingAvailable: boolean;
}

export interface SessionMetrics {
  totalRequests: number;
  successCount: number;
  cancelledCount: number;
  errorCount: number;

  totalLatencyMs: number;
  averageLatencyMs: number;

  requestsByModel: Record<string, number>;
  requestsByFeature: Record<string, number>;

  retryRequests: number;
  escalationCount: number;

  estimatedTotalInputTokens: number;
  estimatedTotalOutputTokens: number;
  estimatedTotalTokens: number;

  estimatedTotalCostUsd: number;
  estimatedBurnRatePerHour: number;

  modelCostUsd: Record<string, number>;
  workflowCostUsd: Record<string, number>;
  workflowTokenUsage: Record<string, { input: number; output: number }>;
  retryAmplificationCostUsd: number;
  retryCostPercentage: number;

}
