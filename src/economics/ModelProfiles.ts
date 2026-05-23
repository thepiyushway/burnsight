export interface ModelProfile {
  avgTokensPerSecond: number;
  reasoningMultiplier: number;
  orchestrationMultiplier: number;
  outputBias: number;
}

const DEFAULT_MODEL_PROFILE: ModelProfile = {
  avgTokensPerSecond: 55,
  reasoningMultiplier: 1.1,
  orchestrationMultiplier: 1.0,
  outputBias: 0.9,
};

const MODEL_PROFILE_REGISTRY: Array<{ match: string; profile: ModelProfile }> = [
  {
    match: 'gpt-5.3-codex',
    profile: {
      avgTokensPerSecond: 95,
      reasoningMultiplier: 1.45,
      orchestrationMultiplier: 1.25,
      outputBias: 1.3,
    },
  },
  {
    match: 'gpt-4o-mini-2024-07-18',
    profile: {
      avgTokensPerSecond: 48,
      reasoningMultiplier: 0.9,
      orchestrationMultiplier: 0.9,
      outputBias: 0.7,
    },
  },
  {
    match: 'gpt-5',
    profile: {
      avgTokensPerSecond: 82,
      reasoningMultiplier: 1.35,
      orchestrationMultiplier: 1.2,
      outputBias: 1.15,
    },
  },
  {
    match: 'claude-sonnet',
    profile: {
      avgTokensPerSecond: 72,
      reasoningMultiplier: 1.25,
      orchestrationMultiplier: 1.1,
      outputBias: 1.0,
    },
  },
  {
    match: 'claude-haiku',
    profile: {
      avgTokensPerSecond: 52,
      reasoningMultiplier: 0.92,
      orchestrationMultiplier: 0.92,
      outputBias: 0.76,
    },
  },
  {
    match: 'gemini-flash',
    profile: {
      avgTokensPerSecond: 64,
      reasoningMultiplier: 0.95,
      orchestrationMultiplier: 0.95,
      outputBias: 0.82,
    },
  },
];

export function resolveModelProfile(model: string): ModelProfile {
  const normalized = model.toLowerCase();
  for (const entry of MODEL_PROFILE_REGISTRY) {
    if (normalized.includes(entry.match)) {
      return entry.profile;
    }
  }
  return DEFAULT_MODEL_PROFILE;
}