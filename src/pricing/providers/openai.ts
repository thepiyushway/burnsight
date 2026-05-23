import { ConfidenceLevel } from '../../telemetry/types';
import type { ModelPricing } from '../pricingRegistry';

export const OPENAI_PRICING: readonly ModelPricing[] = [
  {
    match: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    provider: 'openai',
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.60,
    confidence: ConfidenceLevel.REAL,
    source: 'OpenAI public pricing (2024)',
  },
  {
    match: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    provider: 'openai',
    inputPricePer1M: 0.40,
    outputPricePer1M: 1.60,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate based on public OpenAI tiering',
  },
  {
    match: 'gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    inputPricePer1M: 2.00,
    outputPricePer1M: 8.00,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate based on public OpenAI tiering',
  },
  {
    match: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai',
    inputPricePer1M: 5.00,
    outputPricePer1M: 20.00,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate for GPT-5 Codex family',
  },
  {
    match: 'gpt-5',
    displayName: 'GPT-5 family',
    provider: 'openai',
    inputPricePer1M: 5.00,
    outputPricePer1M: 20.00,
    confidence: ConfidenceLevel.HEURISTIC,
    source: 'BurnSight estimate for GPT-5 family',
  },
];
