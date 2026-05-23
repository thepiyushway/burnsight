import { AIEconomicEvent, SessionMetrics } from '../types/aiTelemetry';

export class SessionAggregator {
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
    estimatedTotalCostUsd: undefined,
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

    if (this.isRetryFeature(event.feature)) {
      this.metrics.retryRequests += 1;
    }

    if (event.estimatedCostUsd !== undefined) {
      this.metrics.estimatedTotalCostUsd =
        (this.metrics.estimatedTotalCostUsd ?? 0) + event.estimatedCostUsd;
    }

    return this.getMetrics();
  }

  public getMetrics(): SessionMetrics {
    return {
      ...this.metrics,
      requestsByModel: { ...this.metrics.requestsByModel },
      requestsByFeature: { ...this.metrics.requestsByFeature },
    };
  }

  private isRetryFeature(feature: string): boolean {
    return feature.toLowerCase().includes('retry-');
  }
}
