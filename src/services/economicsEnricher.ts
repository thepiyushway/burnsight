import { CostEstimator } from '../economics/CostEstimator';
import { TokenEstimator } from '../economics/TokenEstimator';
import { AIEconomicEvent, AIRequestEvent } from '../types/aiTelemetry';

/**
 * Economics enrichment layer.
 * Token and cost fields remain undefined until real token integration is available.
 */
export class EconomicsEnricher {
  private readonly tokenEstimator = new TokenEstimator();
  private readonly costEstimator = new CostEstimator();

  public enrich(event: AIRequestEvent): AIEconomicEvent {
    const tokenEstimate = this.tokenEstimator.estimate(event);
    const costEstimate = this.costEstimator.estimate(
      tokenEstimate.inputTokens,
      tokenEstimate.outputTokens,
      event.model
    );

    const retryAmplifiedCostUsd =
      tokenEstimate.retryAmplification > 1
        ? costEstimate.estimatedCostUsd * (1 - 1 / tokenEstimate.retryAmplification)
        : 0;

    return {
      ...event,
      pricingAvailable: costEstimate.pricing.provider !== 'unknown',
      estimatedInputTokens: tokenEstimate.inputTokens,
      estimatedOutputTokens: tokenEstimate.outputTokens,
      estimatedTotalTokens: tokenEstimate.totalTokens,
      estimatedCostUsd: costEstimate.estimatedCostUsd,
      retryAmplification: tokenEstimate.retryAmplification,
      escalationAmplification: tokenEstimate.escalationAmplification,
      orchestrationAmplification: tokenEstimate.orchestrationAmplification,
      retryAmplifiedCostUsd,
    };
  }
}
