import * as vscode from 'vscode';
import {
  BurnSightEvents,
  ConfidenceLevel,
  CopilotLogEvent,
  DerivedMetric,
  OverlaySnapshot,
  RequestLifecycleState,
  RuntimeSignal,
  SessionState,
  TelemetryState,
} from './types';
import { EventBus } from '../utils/EventBus';
import {
  estimateCost,
  estimateTokensFromChars,
  lookupPricing,
} from '../pricing/pricingRegistry';
import { formatCompact, formatCurrency, formatInteger, formatRate } from '../utils/formatters';
import { TelemetryStateStore } from '../state/TelemetryStateStore';

const VERSION = 'v2.0.0-runtime';
const IDLE_AFTER_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 50;
const MAX_LIFECYCLE_HISTORY = 1000;
const WEBVIEW_UPDATE_DEBOUNCE_MS = 120;

/**
 * TelemetryService is the singleton runtime telemetry authority for BurnSight.
 *
 * Confidence notes:
 * - REAL: request/model/latency/finishReason/requestId/artifact/char count
 * - ESTIMATED: tokens via chars / 4
 * - HEURISTIC: burn rate and input/output split from total estimated tokens
 */
export class TelemetryService implements vscode.Disposable {
  private static instance: TelemetryService | undefined;

  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly stateStore: TelemetryStateStore;

  private state: TelemetryState;
  private sessionState: SessionState = SessionState.IDLE;
  private latestSnapshot: OverlaySnapshot;
  private idleTimer: NodeJS.Timeout | undefined;

  private debugEnabled = false;
  private lastRuntimeSignal: RuntimeSignal['type'] | 'none' = 'none';
  private lastRuntimeSignalConfidence = 0;
  private lastCopilotCommand = 'none';
  private webviewDebounceTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel,
    stateStore?: TelemetryStateStore
  ) {
    this.stateStore = stateStore ?? new TelemetryStateStore(TelemetryService.createEmptyState());
    this.state = this.stateStore.get();
    this.latestSnapshot = this.buildSnapshot();

    this.readDebugConfiguration();
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('burnsight.debugTelemetry')) {
          this.readDebugConfiguration();
        }
      })
    );

    this.subscriptions.push(
      this.bus.on('copilot.request', (event) => {
        this.ingestRuntimeEvent(event);
      })
    );

    this.subscriptions.push(
      this.bus.on('runtime.signal', (signal) => {
        this.lastRuntimeSignal = signal.type;
        this.lastRuntimeSignalConfidence = signal.confidence;
        if (!this.debugEnabled) {
          return;
        }
        this.latestSnapshot = this.buildSnapshot();
        this.emitTelemetryAndWebview();
      })
    );

    this.subscriptions.push(
      this.bus.on('runtime.command', (event) => {
        if (!event.isCopilotRelated) {
          return;
        }
        this.lastCopilotCommand = event.command;
        if (!this.debugEnabled) {
          return;
        }
        this.latestSnapshot = this.buildSnapshot();
        this.emitTelemetryAndWebview();
      })
    );
  }

  public static initialize(
    bus: EventBus<BurnSightEvents>,
    log: vscode.LogOutputChannel,
    stateStore?: TelemetryStateStore
  ): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService(bus, log, stateStore);
    }
    return TelemetryService.instance;
  }

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      throw new Error('TelemetryService is not initialized');
    }
    return TelemetryService.instance;
  }

  public getSnapshot(): OverlaySnapshot {
    return this.latestSnapshot;
  }

  public onSnapshot(listener: (snapshot: OverlaySnapshot) => void): vscode.Disposable {
    return this.bus.on('telemetry.snapshot', listener);
  }

  public dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.webviewDebounceTimer) {
      clearTimeout(this.webviewDebounceTimer);
    }
    vscode.Disposable.from(...this.subscriptions).dispose();
    if (TelemetryService.instance === this) {
      TelemetryService.instance = undefined;
    }
  }

  private readDebugConfiguration(): void {
    this.debugEnabled = vscode.workspace
      .getConfiguration('burnsight')
      .get<boolean>('debugTelemetry', false);

    if (this.debugEnabled) {
      this.log.info('[TelemetryService] Debug telemetry logging enabled');
      this.log.show(true);
    }
  }

  private ingestRuntimeEvent(event: CopilotLogEvent): void {
    const sourcePath = (event.sourceFile ?? '').toLowerCase();
    if (sourcePath.includes('burnsight')) {
      this.log.warn('[TelemetryService] ingestion aborted: self-source detected (burnsight)');
      return;
    }

    if (this.debugEnabled) {
      this.log.info(`[RAW TELEMETRY] ${event.raw}`);
    }

    const previousSessionState = this.sessionState;

    this.state = this.stateStore.update((prev) => {
      const next = { ...prev };
      const now = event.timestamp;

      if (next.sessionStartedAt === null) {
        next.sessionStartedAt = now;
      }
      next.lastActivityAt = now;
      next.observedCharCount += event.observedChars;

      if (event.sessionArtifact) {
        if (!next.sessionArtifacts.includes(event.sessionArtifact)) {
          next.sessionArtifacts = [...next.sessionArtifacts, event.sessionArtifact];
        }
        next.contextAccumulatedChars += event.sessionArtifact.length;
      }

      const requestKey = this.resolveRequestKey(event, next);
      const lifecycle = this.upsertLifecycle(next, requestKey, event);

      if (event.requestId && !next.requestIds.includes(event.requestId)) {
        next.requestIds = [...next.requestIds, event.requestId];
      }

      if (event.model) {
        next.activeModel = event.model;
        if (!next.modelHistory.includes(event.model)) {
          next.modelHistory = [...next.modelHistory, event.model];
        }
      }

      if (event.provider) {
        next.activeProvider = event.provider;
      }

      // We count requests only when a lifecycle completion marker arrives.
      if (event.requestDone && !lifecycle.seenRequestDone) {
        lifecycle.seenRequestDone = true;
        lifecycle.completedAt = now;
        next.requestCount += 1;

        if (lifecycle.finishReason) {
          next.finishReasons = {
            ...next.finishReasons,
            [lifecycle.finishReason]: (next.finishReasons[lifecycle.finishReason] ?? 0) + 1,
          };
        }

        if (lifecycle.latencyMs !== undefined) {
          next.latencies = [...next.latencies, lifecycle.latencyMs];
        }

        const modelName = (lifecycle.model ?? next.activeModel) || 'unknown';
        next.modelRequestCounts = {
          ...next.modelRequestCounts,
          [modelName]: (next.modelRequestCounts[modelName] ?? 0) + 1,
        };

        const totalTokens = estimateTokensFromChars(lifecycle.accumulatedChars);
        // We can only estimate total tokens from chars. Split ratio is heuristic.
        const outputTokens = Math.max(0, Math.round(totalTokens * 0.35));
        const inputTokens = Math.max(0, totalTokens - outputTokens);

        next.estimatedInputTokens += inputTokens;
        next.estimatedOutputTokens += outputTokens;
        next.estimatedTotalTokens += totalTokens;
        next.estimatedContextTokens += estimateTokensFromChars(lifecycle.accumulatedChars);

        const modelTokenTotals = next.modelTokens[modelName] ?? { input: 0, output: 0 };
        next.modelTokens = {
          ...next.modelTokens,
          [modelName]: {
            input: modelTokenTotals.input + inputTokens,
            output: modelTokenTotals.output + outputTokens,
          },
        };

        const pricing = lookupPricing(modelName);
        const requestCost = estimateCost(inputTokens, outputTokens, pricing);

        next.estimatedTotalCost += requestCost;
        next.modelCosts = {
          ...next.modelCosts,
          [modelName]: (next.modelCosts[modelName] ?? 0) + requestCost,
        };
      }

      next.contextAccumulatedChars += event.observedChars;
      const sessionElapsedMs =
        next.sessionStartedAt !== null ? Math.max(1, now - next.sessionStartedAt) : 0;
      next.estimatedBurnRatePerHour =
        sessionElapsedMs > 0 ? (next.estimatedTotalCost / sessionElapsedMs) * 3_600_000 : 0;

      next.recentEvents = [event, ...next.recentEvents].slice(0, MAX_RECENT_EVENTS);
      return next;
    });

    this.sessionState = SessionState.ACTIVE;
    this.scheduleIdleTransition(event.timestamp);

    this.latestSnapshot = this.buildSnapshot();

    if (previousSessionState !== this.sessionState) {
      this.bus.emit('session.stateChanged', {
        previous: previousSessionState,
        current: this.sessionState,
      });
    }

    this.bus.emit('telemetry.updated', {
      event,
      state: this.state,
      snapshot: this.latestSnapshot,
    });

    this.emitSnapshotChannels();
  }

  private resolveRequestKey(event: CopilotLogEvent, state: TelemetryState): string {
    if (event.requestId) {
      return event.requestId;
    }

    // When no requestId is present, tie lifecycle to a synthetic key so we can
    // still account for observed request completions without inventing values.
    if (event.requestDone) {
      const nextId = state.orphanRequestCounter + 1;
      state.orphanRequestCounter = nextId;
      return `orphan-${nextId}`;
    }

    return `orphan-pending-${state.orphanRequestCounter}`;
  }

  private upsertLifecycle(
    state: TelemetryState,
    requestId: string,
    event: CopilotLogEvent
  ): RequestLifecycleState {
    const existing = state.lifecycleByRequestId[requestId];
    const lifecycle: RequestLifecycleState = existing
      ? {
          ...existing,
          lastSeenAt: event.timestamp,
          accumulatedChars: existing.accumulatedChars + event.observedChars,
        }
      : {
          requestId,
          firstSeenAt: event.timestamp,
          lastSeenAt: event.timestamp,
          accumulatedChars: event.observedChars,
          seenRequestDone: false,
        };

    if (event.model) {
      lifecycle.model = event.model;
    }
    if (event.latencyMs !== undefined) {
      lifecycle.latencyMs = event.latencyMs;
    }
    if (event.finishReason) {
      lifecycle.finishReason = event.finishReason;
    }
    if (event.sessionArtifact) {
      lifecycle.sessionArtifact = event.sessionArtifact;
    }
    if (event.provider) {
      lifecycle.provider = event.provider;
    }

    const lifecycleByRequestId = {
      ...state.lifecycleByRequestId,
      [requestId]: lifecycle,
    };

    const keys = Object.keys(lifecycleByRequestId);
    if (keys.length > MAX_LIFECYCLE_HISTORY) {
      keys
        .sort(
          (left, right) =>
            lifecycleByRequestId[left].lastSeenAt - lifecycleByRequestId[right].lastSeenAt
        )
        .slice(0, keys.length - MAX_LIFECYCLE_HISTORY)
        .forEach((key) => {
          delete lifecycleByRequestId[key];
        });
    }

    state.lifecycleByRequestId = lifecycleByRequestId;
    return lifecycle;
  }

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
      this.latestSnapshot = this.buildSnapshot();

      if (previous !== this.sessionState) {
        this.bus.emit('session.stateChanged', {
          previous,
          current: this.sessionState,
        });
      }

      this.emitSnapshotChannels();
    }, IDLE_AFTER_MS);
  }

  private emitSnapshotChannels(): void {
    this.bus.emit('telemetry.snapshot', this.latestSnapshot);
    this.scheduleWebviewUpdate();
    this.bus.emit('statusbar.update', this.latestSnapshot);
  }

  private emitTelemetryAndWebview(): void {
    this.bus.emit('telemetry.snapshot', this.latestSnapshot);
    this.scheduleWebviewUpdate();
  }

  private scheduleWebviewUpdate(): void {
    if (this.webviewDebounceTimer) {
      clearTimeout(this.webviewDebounceTimer);
    }

    this.webviewDebounceTimer = setTimeout(() => {
      this.bus.emit('ui.webviewUpdate', this.latestSnapshot);
    }, WEBVIEW_UPDATE_DEBOUNCE_MS);
  }

  private buildSnapshot(): OverlaySnapshot {
    const state = this.state;
    const hasTelemetry = state.requestCount > 0;
    const nowMs = Date.now();

    const sessionDurationMs =
      state.sessionStartedAt !== null ? Math.max(0, nowMs - state.sessionStartedAt) : 0;
    const sessionDuration = hasTelemetry ? formatDuration(sessionDurationMs) : '0s';

    const averageLatency =
      state.latencies.length > 0
        ? state.latencies.reduce((sum, value) => sum + value, 0) / state.latencies.length
        : 0;

    const burnRatePerHour =
      sessionDurationMs > 0 ? (state.estimatedTotalCost / sessionDurationMs) * 3_600_000 : 0;

    const modelRows: string[][] = hasTelemetry
      ? state.modelHistory.map((modelName) => {
          const modelToken = state.modelTokens[modelName] ?? { input: 0, output: 0 };
          const modelCost = state.modelCosts[modelName] ?? 0;
          const modelRequests = state.modelRequestCounts[modelName] ?? 0;
          return [
            modelName,
            formatInteger(modelRequests),
            formatCompact(modelToken.input + modelToken.output),
            formatCurrency(modelCost),
          ];
        })
      : [['—', '0', '0', '$0.00']];

    const finishReasonRows = Object.entries(state.finishReasons).length
      ? Object.entries(state.finishReasons)
          .sort((left, right) => right[1] - left[1])
          .map(([reason, count]) => ({
            label: reason,
            value: formatInteger(count),
          }))
      : [{ label: 'no-data', value: '0' }];

    const cancelledRequests = Object.entries(state.finishReasons)
      .filter(([reason]) => reason.includes('cancel'))
      .reduce((sum, [, count]) => sum + count, 0);

    const completionCount = Math.max(1, state.requestCount);
    const wasteRatio = cancelledRequests / completionCount;
    const efficiencyRatio = Math.max(0, 1 - wasteRatio);
    const rewriteWasteUsd = state.estimatedTotalCost * wasteRatio;
    const contextWasteTokens = Math.round(state.estimatedContextTokens * wasteRatio);

    const metrics: DerivedMetric[] = [
      {
        id: 'activeModel',
        label: 'Active Model',
        confidence: ConfidenceLevel.REAL,
        value: state.activeModel || 'none',
        formatted: state.activeModel || 'none',
        notes: 'Directly observed from Copilot runtime logs.',
      },
      {
        id: 'activeProvider',
        label: 'Active Provider',
        confidence: ConfidenceLevel.REAL,
        value: state.activeProvider || 'unknown',
        formatted: state.activeProvider || 'unknown',
        notes: 'Provider metadata extracted from runtime logs when available.',
      },
      {
        id: 'requestCount',
        label: 'Request Count',
        confidence: ConfidenceLevel.REAL,
        value: state.requestCount,
        formatted: formatInteger(state.requestCount),
        notes: 'Counted only from observed request done lifecycle markers.',
      },
      {
        id: 'sessionDuration',
        label: 'Session Duration',
        confidence: ConfidenceLevel.REAL,
        value: sessionDurationMs,
        formatted: sessionDuration,
        notes: 'Elapsed wall-clock time since first observed request event.',
      },
      {
        id: 'averageLatency',
        label: 'Average Latency',
        confidence: ConfidenceLevel.REAL,
        value: averageLatency,
        formatted: averageLatency > 0 ? `${Math.round(averageLatency)}ms` : '0ms',
        notes: 'Average of observed request latency fields from logs.',
      },
      {
        id: 'estimatedTotalTokens',
        label: 'Estimated Total Tokens',
        confidence: ConfidenceLevel.ESTIMATED,
        value: state.estimatedTotalTokens,
        formatted: formatCompact(state.estimatedTotalTokens),
        notes: 'Estimated from observed characters using tokens ≈ chars / 4.',
      },
      {
        id: 'estimatedCost',
        label: 'Estimated Cost',
        confidence: ConfidenceLevel.ESTIMATED,
        value: state.estimatedTotalCost,
        formatted: formatCurrency(state.estimatedTotalCost),
        notes: 'Estimated tokens multiplied by model pricing table rates.',
      },
      {
        id: 'estimatedBurnRate',
        label: 'Estimated Burn Rate',
        confidence: ConfidenceLevel.HEURISTIC,
        value: burnRatePerHour,
        formatted: formatRate(burnRatePerHour),
        notes: 'Heuristic extrapolation: estimated cost divided by elapsed session hours.',
      },
      {
        id: 'contextAccumulation',
        label: 'Context Accumulation',
        confidence: ConfidenceLevel.ESTIMATED,
        value: state.estimatedContextTokens,
        formatted: formatCompact(state.estimatedContextTokens),
        notes: 'Estimated context growth via observed telemetry and artifact characters.',
      },
      {
        id: 'efficiency',
        label: 'Session Efficiency',
        confidence: ConfidenceLevel.HEURISTIC,
        value: efficiencyRatio,
        formatted: `${Math.round(efficiencyRatio * 100)}%`,
        notes: 'Heuristic based on completion reasons (cancelled vs completed requests).',
      },
      {
        id: 'rewriteWasteCost',
        label: 'Rewrite Waste Cost',
        confidence: ConfidenceLevel.HEURISTIC,
        value: rewriteWasteUsd,
        formatted: formatCurrency(rewriteWasteUsd),
        notes: 'Heuristic estimated cost attributed to cancelled/retried request outcomes.',
      },
      {
        id: 'contextWasteTokens',
        label: 'Context Waste Tokens',
        confidence: ConfidenceLevel.HEURISTIC,
        value: contextWasteTokens,
        formatted: formatCompact(contextWasteTokens),
        notes: 'Heuristic estimate of context tokens not yielding final accepted responses.',
      },
    ];

    const recentEvents = state.recentEvents
      .slice(0, 10)
      .map((item) => `[${new Date(item.timestamp).toISOString().slice(11, 23)}] ${item.raw}`);

    return {
      title: 'BURNSIGHT_RUNTIME_OBSERVABILITY',
      isLive: this.sessionState === SessionState.ACTIVE,
      version: VERSION,
      runtimeState: this.sessionState,
      runtimeLabel: this.sessionState === SessionState.ACTIVE ? 'ACTIVE' : 'IDLE',
      debug: {
        enabled: this.debugEnabled,
        activeModel: state.activeModel || 'none',
        requestCount: formatInteger(state.requestCount),
        avgLatencyMs: averageLatency > 0 ? `${Math.round(averageLatency)}ms` : '0ms',
        lastEventRaw: state.recentEvents[0]?.raw ?? 'none',
        recentEvents,
        lastRuntimeSignal: this.lastRuntimeSignal,
        lastRuntimeSignalConfidence: `${Math.round(this.lastRuntimeSignalConfidence * 100)}%`,
        lastCopilotCommand: this.lastCopilotCommand,
      },
      metrics,
      cards: [
        {
          id: 'session',
          kind: 'session',
          title: 'SESSION COST (estimated)',
          mainValue: hasTelemetry ? formatCurrency(state.estimatedTotalCost) : '$0.00',
          progressLabel: 'SESSION DURATION',
          progressValue: sessionDuration,
          progressPct: state.requestCount > 0 ? Math.min(100, state.requestCount) : 0,
          rows: [
            {
              label: 'ACTIVE MODEL',
              value: state.activeModel || 'none',
              accent: 'cyan',
            },
            {
              label: 'PROVIDER',
              value: state.activeProvider || 'unknown',
            },
            {
              label: 'REQUEST COUNT',
              value: formatInteger(state.requestCount),
            },
            {
              label: 'BURN RATE',
              value: formatRate(burnRatePerHour),
              accent: 'orange',
            },
          ],
        },
        {
          id: 'models',
          kind: 'table',
          title: 'MODEL BREAKDOWN (derived)',
          columns: ['MODEL', 'REQS', 'TOK', 'COST'],
          rows: modelRows,
        },
        {
          id: 'tokens',
          kind: 'list',
          title: 'TOKEN + CONTEXT (estimated)',
          tone: 'neutral',
          rows: [
            {
              label: 'INPUT TOKENS',
              value: formatCompact(state.estimatedInputTokens),
            },
            {
              label: 'OUTPUT TOKENS',
              value: formatCompact(state.estimatedOutputTokens),
              accent: 'cyan',
            },
            {
              label: 'CONTEXT ACCUMULATION',
              value: formatCompact(state.estimatedContextTokens),
            },
          ],
          footerLabel: 'AVG LATENCY',
          footerValue: averageLatency > 0 ? `${Math.round(averageLatency)}ms` : '0ms',
        },
        {
          id: 'lifecycle',
          kind: 'list',
          title: 'REQUEST LIFECYCLE (real)',
          tone: 'ok',
          rows: finishReasonRows,
          footerLabel: 'SESSION ARTIFACTS',
          footerValue: formatInteger(state.sessionArtifacts.length),
        },
      ],
    };
  }

  public static createEmptyState(): TelemetryState {
    return {
      sessionStartedAt: null,
      lastActivityAt: 0,
      requestCount: 0,
      activeModel: '',
      activeProvider: '',
      modelHistory: [],
      modelRequestCounts: {},
      latencies: [],
      requestIds: [],
      finishReasons: {},
      sessionArtifacts: [],
      lifecycleByRequestId: {},
      orphanRequestCounter: 0,
      observedCharCount: 0,
      contextAccumulatedChars: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTotalTokens: 0,
      estimatedContextTokens: 0,
      modelTokens: {},
      estimatedTotalCost: 0,
      modelCosts: {},
      estimatedBurnRatePerHour: 0,
      recentEvents: [],
    };
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
