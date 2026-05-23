import { estimateCost, lookupPricing, type ModelPricing } from '../pricing/pricingRegistry';

export interface CostEstimateResult {
  pricing: ModelPricing;
  estimatedCostUsd: number;
}

export class CostEstimator {
  public estimate(inputTokens: number, outputTokens: number, model: string): CostEstimateResult {
    const pricing = lookupPricing(model);
    const estimatedCostUsd = estimateCost(inputTokens, outputTokens, pricing);
    return {
      pricing,
      estimatedCostUsd,
    };
  }
}