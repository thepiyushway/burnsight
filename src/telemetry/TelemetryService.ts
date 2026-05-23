import * as vscode from 'vscode';
import {
  BurnSightEvents,
  RuntimeDebugState,
  SessionState,
} from './types';
import { EventBus } from '../utils/EventBus';
import { SessionStore } from '../store/SessionStore';
import { CorrelationEngine } from '../correlation/CorrelationEngine';
import { EconomicsEngine } from '../economics/EconomicsEngine';
import { GitHubCopilotAdapter } from '../adapters/GitHubCopilotAdapter';
import { SessionTelemetry } from '../domain/SessionTelemetry';
import { TraceClassifier } from '../classification/TraceClassifier';
import { EconomicsCalibrator } from '../economics/EconomicsCalibrator';
import { formatCurrency } from '../utils/formatters';

const VERSION = 'v3.0.0-domain';
const IDLE_AFTER_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 50;
const WEBVIEW_UPDATE_DEBOUNCE_MS = 120;

/**
 * BurnSight runtime orchestrator.
 *
 * Owns the full signal-to-session pipeline:
 *
 *   CopilotLogParser  ──copilot.request──►  GitHubCopilotAdapter
 *                                                   │ RawSignal
 *                                                   ▼
 *                                          CorrelationEngine
 *                                                   │ InteractionTrace
 *                                                   ▼
 *                                           EconomicsEngine
 *                                                   │ enriched trace
 *                                                   ▼
 *                                            SessionStore
 *                                                   │ session.updated
 *                                                   ▼
 *                                         OverlayPanel / status bar
 *
 * The TelemetryService also tracks ephemeral RuntimeDebugState for the
 * debug overlay panel and manages the ACTIVE/IDLE state machine.
 *
 * Singleton: use TelemetryService.initialize(bus, log, context).
 */
export class TelemetryService implements vscode.Disposable {
  private static instance: TelemetryService | undefined;

  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly sessionStore: SessionStore;
  private readonly correlationEngine: CorrelationEngine;
  private readonly economicsEngine = new EconomicsEngine();
  private readonly traceClassifier = new TraceClassifier();
  private readonly economicsCalibrator = new EconomicsCalibrator();
  private readonly copilotAdapter: GitHubCopilotAdapter;

  // Ephemeral debug / runtime state
  private sessionState: SessionState = SessionState.IDLE;
  private debugEnabled = false;
  private lastRuntimeSignal: string = 'none';
  private lastRuntimeSignalConfidence = 0;
  private lastCopilotCommand = 'none';
  private lastEventRaw = '';
  private recentEvents: string[] = [];
  private activeModel = '';

  private idleTimer: NodeJS.Timeout | undefined;
  private webviewDebounceTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel,
    context: vscode.ExtensionContext,
  ) {
    this.sessionStore = new SessionStore(context, log);
    this.correlationEngine = new CorrelationEngine(
      this.sessionStore.getSession().sessionId,
    );
    this.copilotAdapter = new GitHubCopilotAdapter(bus, log);

    this.wirePipeline();
    this.subscribeRuntimeEvents();
    this.readDebugConfiguration();

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('burnsight.debugTelemetry')) {
          this.readDebugConfiguration();
        }
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Static factory
  // --------------------------------------------------------------------------

  public static initialize(
    bus: EventBus<BurnSightEvents>,
    log: vscode.LogOutputChannel,
    context: vscode.ExtensionContext,
  ): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService(bus, log, context);
    }
    return TelemetryService.instance;
  }

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      throw new Error('TelemetryService is not initialized');
    }
    return TelemetryService.instance;
  }

  // --------------------------------------------------------------------------
  // Public accessors
  // --------------------------------------------------------------------------

  public getSession(): SessionTelemetry {
    return this.sessionStore.getSession();
  }

  public getRuntimeDebugState(): RuntimeDebugState {
    return this.buildRuntimeDebugState();
  }

  public dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.webviewDebounceTimer) {
      clearTimeout(this.webviewDebounceTimer);
    }
    void this.copilotAdapter.stop();
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.sessionStore.dispose();
    if (TelemetryService.instance === this) {
      TelemetryService.instance = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Pipeline wiring
  // --------------------------------------------------------------------------

  private wirePipeline(): void {
    // 1. Start the adapter (subscribes to copilot.request on the bus)
    void this.copilotAdapter.start();

    // 2. Adapter signal → CorrelationEngine
    const adapterDisposable = this.copilotAdapter.onSignal((signal) => {
      this.log.info(
        `[Pipeline] signal type=${signal.type} requestId=${signal.requestId ?? 'orphan'} model=${signal.model ?? 'unknown'}`,
      );
      this.bus.emit('signal.raw', signal);
      this.correlationEngine.ingest(signal);
    });
    this.subscriptions.push(new vscode.Disposable(() => adapterDisposable.dispose()));

    // 3. CorrelationEngine → EconomicsEngine → SessionStore
    const traceDisposable = this.correlationEngine.onTraceCompleted((trace, endSignal) => {
      this.log.info(
        `[Pipeline] trace completed traceId=${trace.traceId} spans=${trace.spans.length} models=${trace.modelsUsed.join(',')}`,
      );

      const enrichedTrace = this.economicsEngine.enrichTrace(trace, endSignal);

      // Semantic classification: attach span categories and InteractionSemantics
      const classifiedTrace = this.traceClassifier.classify(enrichedTrace);

      // Economics calibration: deflate infrastructure/retry spans to believable estimates
      const calibratedTrace = this.economicsCalibrator.calibrate(classifiedTrace);

      this.log.info(
        `[Pipeline] enriched traceId=${calibratedTrace.traceId} cost=${formatCurrency(calibratedTrace.estimatedCostUsd)} input=${calibratedTrace.estimatedInputTokens} output=${calibratedTrace.estimatedOutputTokens} spans=${calibratedTrace.spans.length} interactions=${calibratedTrace.semantics ? 1 : 0}`,
      );

      this.bus.emit('trace.completed', { trace: calibratedTrace, signal: endSignal });

      // Track active model for debug overlay
      if (calibratedTrace.modelsUsed.length > 0) {
        this.activeModel = calibratedTrace.modelsUsed[calibratedTrace.modelsUsed.length - 1];
      }

      // Transition to ACTIVE and schedule idle
      const previousSessionState = this.sessionState;
      this.sessionState = SessionState.ACTIVE;
      this.scheduleIdleTransition(endSignal.timestamp);

      if (previousSessionState !== this.sessionState) {
        this.bus.emit('session.stateChanged', {
          previous: previousSessionState,
          current: this.sessionState,
        });
      }

      // Persist — triggers session.updated listener below
      this.sessionStore.appendTrace(calibratedTrace);
    });
    this.subscriptions.push(new vscode.Disposable(() => traceDisposable.dispose()));

    // 4. SessionStore → bus events
    const storeDisposable = this.sessionStore.onSessionUpdated((session) => {
      const runtime = this.buildRuntimeDebugState();
      this.log.info(
        `[Pipeline] session updated id=${session.sessionId} traces=${session.interactions.length} totalCost=${formatCurrency(session.aggregateMetrics.estimatedTotalCostUsd)}`,
      );

      this.bus.emit('session.updated', { session, runtime });
      this.bus.emit('statusbar.update', {
        estimatedTotalCostUsd: session.aggregateMetrics.estimatedTotalCostUsd,
        isActive: this.sessionState === SessionState.ACTIVE,
      });

      this.scheduleWebviewDebounce(session, runtime);
    });
    this.subscriptions.push(new vscode.Disposable(() => storeDisposable.dispose()));
  }

  // --------------------------------------------------------------------------
  // Runtime event subscriptions (debug / idle / commands)
  // --------------------------------------------------------------------------

  private subscribeRuntimeEvents(): void {
    this.subscriptions.push(
      this.bus.on('runtime.signal', (signal) => {
        this.lastRuntimeSignal = signal.type;
        this.lastRuntimeSignalConfidence = signal.confidence;
        if (this.debugEnabled) {
          this.emitDebugUpdate();
        }
      }),
    );

    this.subscriptions.push(
      this.bus.on('runtime.command', (event) => {
        if (!event.isCopilotRelated) {
          return;
        }
        this.lastCopilotCommand = event.command;
        if (this.debugEnabled) {
          this.emitDebugUpdate();
        }
      }),
    );

    // Capture recent events for debug panel from the raw copilot.request stream
    this.subscriptions.push(
      this.bus.on('copilot.request', (event) => {
        this.lastEventRaw = event.raw.slice(0, 200);
        this.recentEvents = [this.lastEventRaw, ...this.recentEvents].slice(
          0,
          MAX_RECENT_EVENTS,
        );
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Idle state machine
  // --------------------------------------------------------------------------

  private scheduleIdleTransition(lastActivityAt: number): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (Date.now() - lastActivityAt < IDLE_AFTER_MS) {
        return;
      }
      const previous = this.sessionState;
      this.sessionState = SessionState.IDLE;
      if (previous !== this.sessionState) {
        this.bus.emit('session.stateChanged', {
          previous,
          current: this.sessionState,
        });
        this.bus.emit('statusbar.update', {
          estimatedTotalCostUsd:
            this.sessionStore.getSession().aggregateMetrics.estimatedTotalCostUsd,
          isActive: false,
        });
      }
    }, IDLE_AFTER_MS);
  }

  // --------------------------------------------------------------------------
  // Debounced webview update (legacy ui.webviewUpdate consumers)
  // --------------------------------------------------------------------------

  private scheduleWebviewDebounce(
    session: SessionTelemetry,
    runtime: RuntimeDebugState,
  ): void {
    if (this.webviewDebounceTimer) {
      clearTimeout(this.webviewDebounceTimer);
    }
    this.webviewDebounceTimer = setTimeout(() => {
      this.webviewDebounceTimer = undefined;
      this.bus.emit('ui.webviewUpdate', this.buildLegacyOverlaySnapshot(session, runtime));
    }, WEBVIEW_UPDATE_DEBOUNCE_MS);
  }

  /** Emit a live debug update without persisting a new trace. */
  private emitDebugUpdate(): void {
    const session = this.sessionStore.getSession();
    const runtime = this.buildRuntimeDebugState();
    this.bus.emit('session.updated', { session, runtime });
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  private readDebugConfiguration(): void {
    this.debugEnabled = vscode.workspace
      .getConfiguration('burnsight')
      .get<boolean>('debugTelemetry', false);
    if (this.debugEnabled) {
      this.log.info('[TelemetryService] debug telemetry enabled');
      this.log.show(true);
    }
  }

  // --------------------------------------------------------------------------
  // State builders
  // --------------------------------------------------------------------------

  private buildRuntimeDebugState(): RuntimeDebugState {
    return {
      isLive: this.sessionState === SessionState.ACTIVE,
      label: this.sessionState === SessionState.ACTIVE ? 'ACTIVE' : 'IDLE',
      debugEnabled: this.debugEnabled,
      lastRuntimeSignal: this.lastRuntimeSignal,
      lastRuntimeSignalConfidence: `${(this.lastRuntimeSignalConfidence * 100).toFixed(0)}%`,
      lastCopilotCommand: this.lastCopilotCommand,
      lastEventRaw: this.lastEventRaw,
      recentEvents: this.recentEvents.slice(),
      activeModel: this.activeModel,
      updatedAt: Date.now(),
    };
  }

  /**
   * Builds a minimal OverlaySnapshot for legacy ui.webviewUpdate consumers.
   * Used for backward compat during the arch v3 transition.
   */
  private buildLegacyOverlaySnapshot(
    session: SessionTelemetry,
    runtime: RuntimeDebugState,
  ) {
    return {
      title: 'BurnSight',
      isLive: runtime.isLive,
      version: VERSION,
      runtimeState:
        this.sessionState === SessionState.ACTIVE
          ? SessionState.ACTIVE
          : SessionState.IDLE,
      runtimeLabel: runtime.label,
      debug: {
        enabled: runtime.debugEnabled,
        activeModel: runtime.activeModel,
        requestCount: String(session.aggregateMetrics.totalInteractions),
        avgLatencyMs: `${Math.round(session.aggregateMetrics.averageLatencyMs)}ms`,
        lastEventRaw: runtime.lastEventRaw,
        recentEvents: runtime.recentEvents,
        lastRuntimeSignal: runtime.lastRuntimeSignal,
        lastRuntimeSignalConfidence: runtime.lastRuntimeSignalConfidence,
        lastCopilotCommand: runtime.lastCopilotCommand,
      },
      metrics: [],
      cards: [],
    };
  }
}
