import {
  RuntimeSignal,
  SessionState,
  TelemetryState,
} from '../telemetry/types';

export class RuntimeTelemetryProvider {
  public createInitialState(): TelemetryState {
    return {
      sessionBurn: 6.21,
      contextRemainingPct: 12,
      burnRate: 0,
      efficiencyPct: 81,
      acceptedLoc: 1841,
      rejectedLoc: 422,
      retryLoopsCost: 0.91,
      discardedOutputsCost: 0.42,
      contextWasteCost: 0.37,
      modelBreakdown: [
        { model: 'GPT-4o', tokens: 82400, cost: 5.12 },
        { model: 'Claude Sonnet', tokens: 27800, cost: 1.09 },
      ],
    };
  }

  public applySignal(state: TelemetryState, signal: RuntimeSignal): TelemetryState {
    const insertedChars = signal.metadata?.insertedChars ?? 0;
    const insertedLines = signal.metadata?.insertedLines ?? 0;
    const confidence = Math.max(0, Math.min(1, signal.confidence));

    let burnDelta = 0;
    let contextDrain = 0;
    let acceptedLocDelta = 0;
    let rejectedLocDelta = 0;
    let retryGrowth = 0;
    let discardedGrowth = 0;
    let contextWasteGrowth = 0;
    let tokenMultiplier = 0;

    if (signal.type === 'probable_ai_generation') {
      burnDelta = insertedChars * 0.00038 * (0.6 + confidence);
      contextDrain = insertedChars * 0.012 + insertedLines * 0.06;
      acceptedLocDelta = Math.max(0, insertedLines - 1);
      rejectedLocDelta = Math.max(0, Math.floor(insertedLines * 0.2));
      tokenMultiplier = 2.1;
    }

    if (signal.type === 'rewrite_burst') {
      burnDelta = insertedChars * 0.00048 * (0.7 + confidence);
      contextDrain = insertedChars * 0.014 + insertedLines * 0.12;
      acceptedLocDelta = Math.max(1, Math.floor(insertedLines * 0.7));
      rejectedLocDelta = Math.max(1, Math.floor(insertedLines * 0.5));
      retryGrowth = burnDelta * 0.17;
      discardedGrowth = burnDelta * 0.12;
      contextWasteGrowth = burnDelta * 0.08;
      tokenMultiplier = 2.6;
    }

    if (signal.type === 'apply_changes') {
      burnDelta = 0.11 + insertedChars * 0.00018;
      contextDrain = insertedChars * 0.006 + 0.35;
      acceptedLocDelta = Math.max(1, Math.floor(insertedLines * 0.6));
      rejectedLocDelta = Math.max(0, Math.floor(insertedLines * 0.2));
      retryGrowth = burnDelta * 0.08;
      tokenMultiplier = 1.9;
    }

    if (signal.type === 'large_diff') {
      burnDelta = insertedChars * 0.00031 * (0.7 + confidence);
      contextDrain = insertedChars * 0.01 + insertedLines * 0.1;
      acceptedLocDelta = Math.max(1, Math.floor(insertedLines * 0.5));
      rejectedLocDelta = Math.max(1, Math.floor(insertedLines * 0.35));
      discardedGrowth = burnDelta * 0.2;
      tokenMultiplier = 1.8;
    }

    if (signal.type === 'rapid_delete') {
      burnDelta = 0;
      retryGrowth = 0.03 + (signal.metadata?.deletedChars ?? 0) * 0.00008;
      discardedGrowth = retryGrowth * 0.65;
      contextWasteGrowth = retryGrowth * 0.55;
      acceptedLocDelta = 0;
      rejectedLocDelta = Math.max(1, Math.floor((signal.metadata?.deletedChars ?? 0) / 20));
      tokenMultiplier = 0;
    }

    if (signal.type === 'probable_manual_typing') {
      burnDelta = insertedChars * 0.00003;
      contextDrain = insertedChars * 0.001;
      acceptedLocDelta = Math.max(0, Math.floor(insertedLines * 0.3));
      rejectedLocDelta = 0;
      tokenMultiplier = 0.3;
    }

    const gpt4o = state.modelBreakdown[0];
    const sonnet = state.modelBreakdown[1];

    const tokenDelta = Math.floor(insertedChars * tokenMultiplier);
    const gptTokenDelta = Math.floor(tokenDelta * 0.78);
    const sonnetTokenDelta = Math.max(0, tokenDelta - gptTokenDelta);

    const nextModelBreakdown = [
      {
        model: gpt4o.model,
        tokens: gpt4o.tokens + gptTokenDelta,
        cost: gpt4o.cost + burnDelta * 0.82,
      },
      {
        model: sonnet.model,
        tokens: sonnet.tokens + sonnetTokenDelta,
        cost: sonnet.cost + burnDelta * 0.18,
      },
    ];

    const nextRetryLoops = state.retryLoopsCost + retryGrowth;
    const nextDiscarded = state.discardedOutputsCost + discardedGrowth;
    const nextContextWaste = state.contextWasteCost + contextWasteGrowth;

    const nextSessionBurn =
      nextModelBreakdown[0].cost
      + nextModelBreakdown[1].cost
      + nextRetryLoops
      + nextDiscarded
      + nextContextWaste;

    const burnRateBump = burnDelta * 75;
    const nextBurnRate = Math.max(0, Math.min(18, state.burnRate + burnRateBump));

    return {
      ...state,
      sessionBurn: nextSessionBurn,
      burnRate: nextBurnRate,
      contextRemainingPct: Math.max(2, state.contextRemainingPct - contextDrain),
      efficiencyPct: this.nextEfficiency(state.efficiencyPct, signal.type, confidence),
      acceptedLoc: state.acceptedLoc + acceptedLocDelta,
      rejectedLoc: state.rejectedLoc + rejectedLocDelta,
      retryLoopsCost: nextRetryLoops,
      discardedOutputsCost: nextDiscarded,
      contextWasteCost: nextContextWaste,
      modelBreakdown: nextModelBreakdown,
    };
  }

  public applyDecay(
    state: TelemetryState,
    elapsedMs: number,
    sessionState: SessionState
  ): TelemetryState {
    const elapsedSeconds = elapsedMs / 1000;

    if (sessionState === SessionState.IDLE) {
      const nextBurnRate = Math.max(0, state.burnRate - 2.4 * elapsedSeconds);
      return {
        ...state,
        burnRate: nextBurnRate,
      };
    }

    if (sessionState === SessionState.COOLING) {
      const nextBurnRate = Math.max(0, state.burnRate - 1.4 * elapsedSeconds);
      return {
        ...state,
        burnRate: nextBurnRate,
      };
    }

    if (sessionState === SessionState.ACTIVE) {
      const nextBurnRate = Math.max(0, state.burnRate - 0.35 * elapsedSeconds);
      return {
        ...state,
        burnRate: nextBurnRate,
      };
    }

    return state;
  }

  private nextEfficiency(current: number, signalType: RuntimeSignal['type'], confidence: number): number {
    if (signalType === 'probable_manual_typing') {
      return Math.max(55, Math.min(96, current + 0.03));
    }

    if (signalType === 'rapid_delete') {
      return Math.max(55, Math.min(96, current - 0.5 * confidence));
    }

    if (signalType === 'rewrite_burst') {
      return Math.max(55, Math.min(96, current - 0.2 + confidence * 0.1));
    }

    if (signalType === 'apply_changes' || signalType === 'probable_ai_generation') {
      return Math.max(55, Math.min(96, current + 0.06 * confidence));
    }

    return Math.max(55, Math.min(96, current));
  }
}
