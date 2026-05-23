import { ConfidenceLevel } from '../../telemetry/types';
import type { ModelPricing } from '../pricingRegistry';

export const ANTHROPIC_PRICING: readonly ModelPricing[] = [
  {
    match: 'claude-opus',
    displayName: 'Claude Opus',
    provider: 'anthropic',
    inputPricePer1M: 15.00,
    outputPricePer1M: 75.00,
    confidence: ConfidenceLevel.REAL,
    source: 'Anthropic public pricing (2024)',
  },
  {
    match: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    provider: 'anthropic',
    inputPricePer1M: 3.00,
    outputPricePer1M: 15.00,
    confidence: ConfidenceLevel.REAL,
    source: 'Anthropic public pricing (2024)',
  },
  {
    match: 'claude-haiku',
    displayName: 'Claude Haiku',
    provider: 'anthropic',
    inputPricePer1M: 0.25,
    outputPricePer1M: 1.25,
    confidence: ConfidenceLevel.REAL,
    source: 'Anthropic public pricing (2024)',
  },
  {
    match: 'claude',
    displayName: 'Claude (generic)',
    provider: 'anthropic',
    inputPricePer1M: 3.00,
    outputPricePer1M: 15.00,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight fallback for unknown Claude variant',
  },
];
