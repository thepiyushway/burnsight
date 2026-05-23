import { ConfidenceLevel } from '../telemetry/types';
import { ANTHROPIC_PRICING } from './providers/anthropic';
import { GOOGLE_PRICING } from './providers/google';
import { OPENAI_PRICING } from './providers/openai';

export type PricingProvider = 'openai' | 'anthropic' | 'google' | 'unknown';

export interface ModelPricing {
  match: string;
  displayName: string;
  provider: PricingProvider;
  inputPricePer1M: number;
  outputPricePer1M: number;
  confidence: ConfidenceLevel;
  source: string;
}

/**
 * Provider-modular registry for estimated economics.
 *
 * Assumption: pricing may differ from Copilot internal economics. These values
 * are observability-oriented estimates using publicly available API pricing and
 * conservative heuristics where no official rates are published.
 */
export const PRICING_REGISTRY: readonly ModelPricing[] = [
  ...OPENAI_PRICING,
  ...ANTHROPIC_PRICING,
  ...GOOGLE_PRICING,
];

export const FALLBACK_PRICING: ModelPricing = {
  match: '*',
  displayName: 'Unknown Model',
  provider: 'unknown',
  inputPricePer1M: 2.50,
  outputPricePer1M: 10.00,
  confidence: ConfidenceLevel.HEURISTIC,
  source: 'BurnSight unknown-model fallback',
};

export function lookupPricing(modelName: string): ModelPricing {
  const normalized = modelName.toLowerCase();
  for (const pricing of PRICING_REGISTRY) {
    if (normalized.includes(pricing.match.toLowerCase())) {
      return pricing;
    }
  }

  return {
    ...FALLBACK_PRICING,
    displayName: modelName || FALLBACK_PRICING.displayName,
  };
}

export function estimateCost(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPricePer1M +
    (outputTokens / 1_000_000) * pricing.outputPricePer1M
  );
}

export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}
