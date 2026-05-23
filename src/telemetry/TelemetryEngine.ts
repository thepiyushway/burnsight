import * as vscode from 'vscode';
import { MetricRegistry } from '../metrics/MetricRegistry';
import { RuntimeTelemetryProvider } from '../providers/RuntimeTelemetryProvider';
import { SessionEngine } from '../sessions/SessionEngine';
import { EventBus } from '../utils/EventBus';
import { formatCompact, formatCurrency } from '../utils/formatters';
import {
  BurnSightEvents,
  MetricValue,
  OverlaySnapshot,
  RuntimeObservation,
  RuntimeSignal,
  RuntimeSignalType,
  SessionState,
  TelemetryState,
} from './types';

interface TelemetryEngineArgs {
  bus: EventBus<BurnSightEvents>;
  sessionEngine: SessionEngine;
  metricRegistry: MetricRegistry;
  telemetryProvider: RuntimeTelemetryProvider;
}

export class TelemetryEngine implements vscode.Disposable {
  private readonly bus: EventBus<BurnSightEvents>;
  private readonly sessionEngine: SessionEngine;
  private readonly metricRegistry: MetricRegistry;
  private readonly telemetryProvider: RuntimeTelemetryProvider;
  private readonly subscriptions: vscode.Disposable[] = [];
  private state: TelemetryState;
  private sessionState: SessionState;
  private lastSignalType: RuntimeSignalType | 'none' = 'none';
  private lastSignalConfidence = 0;
  private probableAiInsertion = false;
  private lastCopilotCommand = 'none';
  private lastInsertionVelocity = 0;
  private latestSnapshot: OverlaySnapshot;

  constructor(args: TelemetryEngineArgs) {
    this.bus = args.bus;
    this.sessionEngine = args.sessionEngine;
    this.metricRegistry = args.metricRegistry;
    this.telemetryProvider = args.telemetryProvider;

    this.state = this.telemetryProvider.createInitialState();
    this.sessionState = this.sessionEngine.getState();
    this.latestSnapshot = this.buildSnapshot();

    this.subscriptions.push(
      this.bus.on('session.tick', ({ elapsedMs, state }) => {
        this.sessionState = state;
        this.state = this.telemetryProvider.applyDecay(this.state, elapsedMs, state);
        this.latestSnapshot = this.buildSnapshot();
        this.bus.emit('telemetry.snapshot', this.latestSnapshot);
      })
    );

    this.subscriptions.push(
      this.bus.on('session.stateChanged', ({ current }) => {
        this.sessionState = current;
      })
    );

    this.subscriptions.push(
      this.bus.on('runtime.signal', (signal) => {
        this.consumeRuntimeSignal(signal);
      })
    );

    this.subscriptions.push(
      this.bus.on('runtime.observation', (observation) => {
        this.consumeRuntimeObservation(observation);
      })
    );

    this.subscriptions.push(
      this.bus.on('runtime.command', (event) => {
        if (event.isCopilotRelated) {
          this.lastCopilotCommand = event.command;
          this.latestSnapshot = this.buildSnapshot();
          this.bus.emit('telemetry.snapshot', this.latestSnapshot);
        }
      })
    );

    this.sessionEngine.start();
  }

  public getSnapshot(): OverlaySnapshot {
    return this.latestSnapshot;
  }

  public onSnapshot(listener: (snapshot: OverlaySnapshot) => void): vscode.Disposable {
    return this.bus.on('telemetry.snapshot', listener);
  }

  public onSessionStateChanged(
    listener: (event: BurnSightEvents['session.stateChanged']) => void
  ): vscode.Disposable {
    return this.bus.on('session.stateChanged', listener);
  }

  public dispose(): void {
    this.sessionEngine.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private buildSnapshot(): OverlaySnapshot {
    const metrics = this.metricRegistry.evaluate({ state: this.state });
    const read = (id: string): MetricValue => {
      const metric = metrics.get(id);
      if (!metric) {
        throw new Error(`Unknown metric id: ${id}`);
      }

      return metric;
    };

    return {
      title: 'ECON_FORECAST_V1',
      isLive: this.sessionState !== SessionState.IDLE,
      version: 'v0.8.2-BETA',
      runtimeState: this.sessionState,
      runtimeLabel: this.getRuntimeLabel(this.sessionState),
      debug: {
        enabled: true,
        lastSignalType: this.lastSignalType,
        lastSignalConfidence: `${Math.round(this.lastSignalConfidence * 100)}%`,
        probableAiInsertion: this.probableAiInsertion ? 'YES' : 'NO',
        lastCopilotCommand: this.lastCopilotCommand,
        lastInsertionVelocity: `${this.lastInsertionVelocity.toFixed(1)} chars/s`,
      },
      cards: [
        {
          id: 'session',
          kind: 'session',
          title: 'SESSION ACCRUAL',
          mainValue: read('sessionBurn').formatted,
          progressLabel: 'CONTEXT REMAINING',
          progressValue: read('contextRemaining').formatted,
          progressPct: this.state.contextRemainingPct,
          rows: [
            {
              label: read('burnRate').label,
              value: read('burnRate').formatted,
            },
            {
              label: read('efficiency').label,
              value: read('efficiency').formatted,
              accent: 'green',
            },
          ],
        },
        {
          id: 'models',
          kind: 'table',
          title: 'MODELS',
          columns: ['MODEL', 'TOK', 'COST'],
          rows: this.state.modelBreakdown.map((model) => [
            model.model,
            formatCompact(model.tokens),
            formatCurrency(model.cost),
          ]),
        },
        {
          id: 'wasted',
          kind: 'list',
          title: 'WASTED SPEND',
          tone: 'danger',
          rows: [
            {
              label: read('retryLoops').label,
              value: read('retryLoops').formatted,
            },
            {
              label: read('discardedOutputs').label,
              value: read('discardedOutputs').formatted,
            },
            {
              label: read('contextWaste').label,
              value: read('contextWaste').formatted,
              accent: 'orange',
            },
          ],
          footerLabel: read('wasteRatio').label,
          footerValue: read('wasteRatio').formatted,
        },
        {
          id: 'performance',
          kind: 'list',
          title: 'PERFORMANCE',
          tone: 'ok',
          rows: [
            {
              label: read('acceptedLoc').label,
              value: read('acceptedLoc').formatted,
            },
            {
              label: read('rejectedLoc').label,
              value: read('rejectedLoc').formatted,
            },
            {
              label: read('acceptanceRate').label,
              value: read('acceptanceRate').formatted,
              accent: 'green',
            },
          ],
          footerLabel: read('costPerAcceptedLoc').label,
          footerValue: read('costPerAcceptedLoc').formatted,
        },
      ],
    };
  }

  private getRuntimeLabel(state: SessionState): string {
    if (state === SessionState.BURST) {
      return 'BURST';
    }

    if (state === SessionState.ACTIVE) {
      return 'LIVE';
    }

    if (state === SessionState.COOLING) {
      return 'COOLING';
    }

    return 'IDLE';
  }

  private consumeRuntimeSignal(signal: RuntimeSignal): void {
    this.lastSignalType = signal.type;
    this.lastSignalConfidence = signal.confidence;
    this.state = this.telemetryProvider.applySignal(this.state, signal);
    this.latestSnapshot = this.buildSnapshot();
    this.bus.emit('telemetry.snapshot', this.latestSnapshot);
  }

  private consumeRuntimeObservation(observation: RuntimeObservation): void {
    this.probableAiInsertion = observation.looksAiGenerated;
    this.lastInsertionVelocity = observation.insertionVelocity;
    this.latestSnapshot = this.buildSnapshot();
    this.bus.emit('telemetry.snapshot', this.latestSnapshot);
  }
}
