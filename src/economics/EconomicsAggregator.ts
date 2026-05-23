import { AIEconomicEvent } from '../types/aiTelemetry';

export interface EconomicsAggregate {
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
  escalationCount: number;
}

export class EconomicsAggregator {
  private startedAt: number | null = null;
  private aggregate: EconomicsAggregate = {
    estimatedTotalInputTokens: 0,
    estimatedTotalOutputTokens: 0,
    estimatedTotalTokens: 0,
    estimatedTotalCostUsd: 0,
    estimatedBurnRatePerHour: 0,
    modelCostUsd: {},
    workflowCostUsd: {},
    workflowTokenUsage: {},
    retryAmplificationCostUsd: 0,
    retryCostPercentage: 0,
    escalationCount: 0,
  };

  public consume(event: AIEconomicEvent): EconomicsAggregate {
    if (this.startedAt === null) {
      this.startedAt = event.timestamp;
    }

    this.aggregate.estimatedTotalInputTokens += event.estimatedInputTokens;
    this.aggregate.estimatedTotalOutputTokens += event.estimatedOutputTokens;
    this.aggregate.estimatedTotalTokens += event.estimatedTotalTokens;
    this.aggregate.estimatedTotalCostUsd += event.estimatedCostUsd;

    this.aggregate.modelCostUsd[event.model] =
      (this.aggregate.modelCostUsd[event.model] ?? 0) + event.estimatedCostUsd;

    this.aggregate.workflowCostUsd[event.feature] =
      (this.aggregate.workflowCostUsd[event.feature] ?? 0) + event.estimatedCostUsd;

    const workflowTokens = this.aggregate.workflowTokenUsage[event.feature] ?? { input: 0, output: 0 };
    workflowTokens.input += event.estimatedInputTokens;
    workflowTokens.output += event.estimatedOutputTokens;
    this.aggregate.workflowTokenUsage[event.feature] = workflowTokens;

    this.aggregate.retryAmplificationCostUsd += event.retryAmplifiedCostUsd;
    this.aggregate.escalationCount += event.escalationCount ?? 0;

    const elapsedMs = Math.max(1, event.timestamp - (this.startedAt ?? event.timestamp));
    this.aggregate.estimatedBurnRatePerHour =
      this.aggregate.estimatedTotalCostUsd / (elapsedMs / (60 * 60 * 1000));

    this.aggregate.retryCostPercentage =
      this.aggregate.estimatedTotalCostUsd > 0
        ? (this.aggregate.retryAmplificationCostUsd / this.aggregate.estimatedTotalCostUsd) * 100
        : 0;

    return this.getAggregate();
  }

  public getAggregate(): EconomicsAggregate {
    return {
      ...this.aggregate,
      modelCostUsd: { ...this.aggregate.modelCostUsd },
      workflowCostUsd: { ...this.aggregate.workflowCostUsd },
      workflowTokenUsage: { ...this.aggregate.workflowTokenUsage },
    };
  }
}