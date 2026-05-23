import { ConfidenceLevel } from '../../telemetry/types';
import type { ModelPricing } from '../pricingRegistry';

export const GOOGLE_PRICING: readonly ModelPricing[] = [
  {
    match: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    inputPricePer1M: 3.50,
    outputPricePer1M: 10.50,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate based on Google AI pricing patterns',
  },
  {
    match: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'google',
    inputPricePer1M: 0.35,
    outputPricePer1M: 1.05,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate based on Google AI pricing patterns',
  },
  {
    match: 'gemini',
    displayName: 'Gemini (generic)',
    provider: 'google',
    inputPricePer1M: 1.00,
    outputPricePer1M: 3.00,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight fallback for unknown Gemini variant',
  },
];
