import { TelemetryContext, MetricValue } from '../telemetry/types';
import {
  formatCompact,
  formatCurrency,
  formatInteger,
  formatPercent,
  formatRate,
} from '../utils/formatters';

type MetricFormatter = (value: number) => string;
type MetricCalculator = (context: TelemetryContext) => number;

export interface MetricDefinition {
  id: string;
  label: string;
  enabled: boolean;
  formatter: MetricFormatter;
  calculate: MetricCalculator;
}

export class MetricRegistry {
  private definitions = new Map<string, MetricDefinition>();

  public register(definition: MetricDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  public setEnabled(metricId: string, enabled: boolean): void {
    const definition = this.definitions.get(metricId);
    if (!definition) {
      return;
    }

    this.definitions.set(metricId, { ...definition, enabled });
  }

  public evaluate(context: TelemetryContext): Map<string, MetricValue> {
    const output = new Map<string, MetricValue>();

    for (const definition of this.definitions.values()) {
      const value = definition.calculate(context);
      output.set(definition.id, {
        id: definition.id,
        label: definition.label,
        enabled: definition.enabled,
        value,
        formatted: definition.formatter(value),
      });
    }

    return output;
  }
}

export function registerDefaultMetrics(registry: MetricRegistry): void {
  registry.register({
    id: 'sessionBurn',
    label: 'Session Burn',
    enabled: true,
    formatter: formatCurrency,
    calculate: ({ state }) => state.sessionBurn,
  });

  registry.register({
    id: 'contextRemaining',
    label: 'Context Remaining',
    enabled: true,
    formatter: formatPercent,
    calculate: ({ state }) => state.contextRemainingPct,
  });

  registry.register({
    id: 'burnRate',
    label: 'Burn Rate',
    enabled: true,
    formatter: formatRate,
    calculate: ({ state }) => state.burnRate,
  });

  registry.register({
    id: 'efficiency',
    label: 'Efficiency',
    enabled: true,
    formatter: formatPercent,
    calculate: ({ state }) => state.efficiencyPct,
  });

  registry.register({
    id: 'retryLoops',
    label: 'Retry Loops',
    enabled: true,
    formatter: formatCurrency,
    calculate: ({ state }) => state.retryLoopsCost,
  });

  registry.register({
    id: 'discardedOutputs',
    label: 'Discarded Outputs',
    enabled: true,
    formatter: formatCurrency,
    calculate: ({ state }) => state.discardedOutputsCost,
  });

  registry.register({
    id: 'contextWaste',
    label: 'Context Waste',
    enabled: true,
    formatter: formatCurrency,
    calculate: ({ state }) => state.contextWasteCost,
  });

  registry.register({
    id: 'wasteRatio',
    label: 'Waste Ratio',
    enabled: true,
    formatter: formatPercent,
    calculate: ({ state }) => {
      if (state.sessionBurn === 0) {
        return 0;
      }

      const wasted =
        state.retryLoopsCost + state.discardedOutputsCost + state.contextWasteCost;
      return (wasted / state.sessionBurn) * 100;
    },
  });

  registry.register({
    id: 'acceptedLoc',
    label: 'Accepted LOC',
    enabled: true,
    formatter: formatInteger,
    calculate: ({ state }) => state.acceptedLoc,
  });

  registry.register({
    id: 'rejectedLoc',
    label: 'Rejected LOC',
    enabled: true,
    formatter: formatInteger,
    calculate: ({ state }) => state.rejectedLoc,
  });

  registry.register({
    id: 'acceptanceRate',
    label: 'Acceptance Rate',
    enabled: true,
    formatter: formatPercent,
    calculate: ({ state }) => {
      const total = state.acceptedLoc + state.rejectedLoc;
      if (total === 0) {
        return 0;
      }

      return (state.acceptedLoc / total) * 100;
    },
  });

  registry.register({
    id: 'costPerAcceptedLoc',
    label: 'Cost / ACC LOC',
    enabled: true,
    formatter: (value: number) => `${formatCurrency(value)}`,
    calculate: ({ state }) => {
      if (state.acceptedLoc === 0) {
        return 0;
      }

      return state.sessionBurn / state.acceptedLoc;
    },
  });

  registry.register({
    id: 'modelTotalTokens',
    label: 'Model Tokens',
    enabled: true,
    formatter: formatCompact,
    calculate: ({ state }) =>
      state.modelBreakdown.reduce((sum, model) => sum + model.tokens, 0),
  });
}
