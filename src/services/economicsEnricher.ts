import { AIEconomicEvent, AIRequestEvent, MODEL_PRICING } from '../types/aiTelemetry';

/**
 * Economics enrichment layer.
 * Token and cost fields remain undefined until real token integration is available.
 */
export class EconomicsEnricher {
  public enrich(event: AIRequestEvent): AIEconomicEvent {
    const pricingAvailable = Boolean(MODEL_PRICING[event.model]);

    return {
      ...event,
      pricingAvailable,
      estimatedInputTokens: undefined,
      estimatedOutputTokens: undefined,
      estimatedCostUsd: undefined,
    };
  }
}
