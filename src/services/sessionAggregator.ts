import { EconomicsAggregator } from '../economics/EconomicsAggregator';
import { AIEconomicEvent, SessionMetrics } from '../types/aiTelemetry';

export class SessionAggregator {
  private readonly economicsAggregator = new EconomicsAggregator();

  private metrics: SessionMetrics = {
    totalRequests: 0,
    successCount: 0,
    cancelledCount: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    averageLatencyMs: 0,
    requestsByModel: {},
    requestsByFeature: {},
    retryRequests: 0,
    escalationCount: 0,
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
  };

  public consume(event: AIEconomicEvent): SessionMetrics {
    this.metrics.totalRequests += 1;

    if (event.status === 'success') {
      this.metrics.successCount += 1;
    } else if (event.status === 'cancelled') {
      this.metrics.cancelledCount += 1;
    } else {
      this.metrics.errorCount += 1;
    }

    this.metrics.totalLatencyMs += event.latencyMs;
    this.metrics.averageLatencyMs =
      this.metrics.totalRequests > 0
        ? this.metrics.totalLatencyMs / this.metrics.totalRequests
        : 0;

    this.metrics.requestsByModel[event.model] =
      (this.metrics.requestsByModel[event.model] ?? 0) + 1;

    this.metrics.requestsByFeature[event.feature] =
      (this.metrics.requestsByFeature[event.feature] ?? 0) + 1;

    if (event.isRetry || this.isRetryFeature(event.feature)) {
      this.metrics.retryRequests += 1;
    }

    this.metrics.escalationCount += event.escalationCount ?? 0;

    const economics = this.economicsAggregator.consume(event);
    this.metrics.estimatedTotalInputTokens = economics.estimatedTotalInputTokens;
    this.metrics.estimatedTotalOutputTokens = economics.estimatedTotalOutputTokens;
    this.metrics.estimatedTotalTokens = economics.estimatedTotalTokens;
    this.metrics.estimatedTotalCostUsd = economics.estimatedTotalCostUsd;
    this.metrics.estimatedBurnRatePerHour = economics.estimatedBurnRatePerHour;
    this.metrics.modelCostUsd = { ...economics.modelCostUsd };
    this.metrics.workflowCostUsd = { ...economics.workflowCostUsd };
    this.metrics.workflowTokenUsage = { ...economics.workflowTokenUsage };
    this.metrics.retryAmplificationCostUsd = economics.retryAmplificationCostUsd;
    this.metrics.retryCostPercentage = economics.retryCostPercentage;

    return this.getMetrics();
  }

  public getMetrics(): SessionMetrics {
    return {
      ...this.metrics,
      requestsByModel: { ...this.metrics.requestsByModel },
      requestsByFeature: { ...this.metrics.requestsByFeature },
      modelCostUsd: { ...this.metrics.modelCostUsd },
      workflowCostUsd: { ...this.metrics.workflowCostUsd },
      workflowTokenUsage: { ...this.metrics.workflowTokenUsage },
    };
  }

  private isRetryFeature(feature: string): boolean {
    return feature.toLowerCase().includes('retry');
  }
}
