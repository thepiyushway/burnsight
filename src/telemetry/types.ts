export interface ModelCostEntry {
  model: string;
  tokens: number;
  cost: number;
}

export enum SessionState {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  BURST = 'BURST',
  COOLING = 'COOLING',
}

export type RuntimeSignalType =
  | 'probable_ai_generation'
  | 'probable_manual_typing'
  | 'rewrite_burst'
  | 'apply_changes'
  | 'large_diff'
  | 'rapid_delete';

export interface RuntimeSignal {
  type: RuntimeSignalType;
  confidence: number;
  source: string;
  timestamp: number;
  metadata?: {
    fileName?: string;
    insertedChars?: number;
    insertedLines?: number;
    deletedChars?: number;
    insertionVelocity?: number;
    preview?: string;
    command?: string;
  };
}

export interface RuntimeObservation {
  fileName: string;
  insertedChars: number;
  insertedLines: number;
  deletedChars: number;
  insertionTimestamp: number;
  insertionVelocity: number;
  looksAiGenerated: boolean;
  confidence: number;
  previewSnippet: string;
}

export interface RuntimeDebugSnapshot {
  enabled: boolean;
  lastSignalType: string;
  lastSignalConfidence: string;
  probableAiInsertion: string;
  lastCopilotCommand: string;
  lastInsertionVelocity: string;
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
  runtimeState: SessionState;
  runtimeLabel: string;
  debug: RuntimeDebugSnapshot;
  cards: OverlayCardSnapshot[];
}

export interface BurnSightEvents {
  'session.tick': { elapsedMs: number; state: SessionState };
  'session.stateChanged': {
    previous: SessionState;
    current: SessionState;
    reason: string;
  };
  'runtime.observation': RuntimeObservation;
  'runtime.signal': RuntimeSignal;
  'runtime.command': {
    command: string;
    timestamp: number;
    isCopilotRelated: boolean;
  };
  'telemetry.snapshot': OverlaySnapshot;
}
