import { TelemetryState } from '../telemetry/types';

export class FakeTelemetryProvider {
  public createInitialState(): TelemetryState {
    return {
      sessionBurn: 6.21,
      contextRemainingPct: 12,
      burnRate: 5.82,
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

  public advance(state: TelemetryState, elapsedMs: number): TelemetryState {
    const elapsedMinutes = elapsedMs / 60000;
    const burnDelta = (state.burnRate / 60) * elapsedMinutes;

    const contextDrain = 0.08 + Math.random() * 0.12;
    const newContext = Math.max(2, state.contextRemainingPct - contextDrain);

    const acceptanceDrift = (Math.random() - 0.5) * 1.2;
    const nextEfficiency = Math.min(96, Math.max(60, state.efficiencyPct + acceptanceDrift));

    const nextAcceptedLoc = state.acceptedLoc + Math.floor(2 + Math.random() * 11);
    const nextRejectedLoc = state.rejectedLoc + Math.floor(Math.random() * 4);

    const retryGrowth = 0.002 + Math.random() * 0.007;
    const discardedGrowth = 0.001 + Math.random() * 0.004;
    const contextWasteGrowth = 0.001 + Math.random() * 0.003;

    const gpt4o = state.modelBreakdown[0];
    const sonnet = state.modelBreakdown[1];

    const gptTokensDelta = 110 + Math.floor(Math.random() * 230);
    const sonnetTokensDelta = 35 + Math.floor(Math.random() * 120);

    const nextModelBreakdown = [
      {
        model: gpt4o.model,
        tokens: gpt4o.tokens + gptTokensDelta,
        cost: gpt4o.cost + burnDelta * 0.82,
      },
      {
        model: sonnet.model,
        tokens: sonnet.tokens + sonnetTokensDelta,
        cost: sonnet.cost + burnDelta * 0.18,
      },
    ];

    const nextSessionBurn =
      nextModelBreakdown[0].cost +
      nextModelBreakdown[1].cost +
      state.retryLoopsCost +
      state.discardedOutputsCost +
      state.contextWasteCost;

    return {
      ...state,
      sessionBurn: nextSessionBurn,
      contextRemainingPct: newContext,
      efficiencyPct: nextEfficiency,
      acceptedLoc: nextAcceptedLoc,
      rejectedLoc: nextRejectedLoc,
      retryLoopsCost: state.retryLoopsCost + retryGrowth,
      discardedOutputsCost: state.discardedOutputsCost + discardedGrowth,
      contextWasteCost: state.contextWasteCost + contextWasteGrowth,
      modelBreakdown: nextModelBreakdown,
    };
  }
}
