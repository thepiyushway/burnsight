export interface ModelCostEntry {
  model: string;
  tokens: number;
  cost: number;
}

export interface TelemetryState {
  sessionBurn: number;
  contextRemainingPct: number;
  burnRate: number;
  efficiencyPct: number;
  acceptedLoc: number;
  rejectedLoc: number;
  retryLoopsCost: number;
  discardedOutputsCost: number;
  contextWasteCost: number;
  modelBreakdown: ModelCostEntry[];
}

export interface MetricValue {
  id: string;
  label: string;
  enabled: boolean;
  value: number;
  formatted: string;
}

export interface TelemetryContext {
  state: TelemetryState;
}

export interface SessionCardSnapshot {
  id: string;
  kind: 'session';
  title: string;
  mainValue: string;
  progressLabel: string;
  progressValue: string;
  progressPct: number;
  rows: Array<{ label: string; value: string; accent?: 'cyan' | 'green' | 'orange' }>;
}

export interface TableCardSnapshot {
  id: string;
  kind: 'table';
  title: string;
  columns: string[];
  rows: string[][];
}

export interface ListCardSnapshot {
  id: string;
  kind: 'list';
  title: string;
  tone: 'neutral' | 'danger' | 'ok';
  rows: Array<{ label: string; value: string; accent?: 'cyan' | 'green' | 'orange' }>;
  footerLabel?: string;
  footerValue?: string;
}

export type OverlayCardSnapshot =
  | SessionCardSnapshot
  | TableCardSnapshot
  | ListCardSnapshot;

export interface OverlaySnapshot {
  title: string;
  isLive: boolean;
  version: string;
  cards: OverlayCardSnapshot[];
}

export interface BurnSightEvents {
  'session.tick': { elapsedMs: number };
  'telemetry.snapshot': OverlaySnapshot;
}
