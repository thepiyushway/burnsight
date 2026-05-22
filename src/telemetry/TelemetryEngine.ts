import * as vscode from 'vscode';
import { MetricRegistry } from '../metrics/MetricRegistry';
import { FakeTelemetryProvider } from '../providers/FakeTelemetryProvider';
import { SessionEngine } from '../sessions/SessionEngine';
import { EventBus } from '../utils/EventBus';
import { formatCompact, formatCurrency } from '../utils/formatters';
import {
  BurnSightEvents,
  MetricValue,
  OverlaySnapshot,
  TelemetryState,
} from './types';

interface TelemetryEngineArgs {
  bus: EventBus<BurnSightEvents>;
  sessionEngine: SessionEngine;
  metricRegistry: MetricRegistry;
  telemetryProvider: FakeTelemetryProvider;
}

export class TelemetryEngine implements vscode.Disposable {
  private readonly bus: EventBus<BurnSightEvents>;
  private readonly sessionEngine: SessionEngine;
  private readonly metricRegistry: MetricRegistry;
  private readonly telemetryProvider: FakeTelemetryProvider;
  private readonly subscriptions: vscode.Disposable[] = [];
  private state: TelemetryState;
  private latestSnapshot: OverlaySnapshot;

  constructor(args: TelemetryEngineArgs) {
    this.bus = args.bus;
    this.sessionEngine = args.sessionEngine;
    this.metricRegistry = args.metricRegistry;
    this.telemetryProvider = args.telemetryProvider;

    this.state = this.telemetryProvider.createInitialState();
    this.latestSnapshot = this.buildSnapshot();

    this.subscriptions.push(
      this.bus.on('session.tick', ({ elapsedMs }) => {
        this.state = this.telemetryProvider.advance(this.state, elapsedMs);
        this.latestSnapshot = this.buildSnapshot();
        this.bus.emit('telemetry.snapshot', this.latestSnapshot);
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
      isLive: true,
      version: 'v0.8.2-BETA',
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
}
