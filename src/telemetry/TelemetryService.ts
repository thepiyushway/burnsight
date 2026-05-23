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
  SessionTimelineEvent,
  TelemetryState,
} from './types';
import { EventBus } from '../utils/EventBus';
import { formatCurrency, formatInteger } from '../utils/formatters';
import { TelemetryStateStore } from '../state/TelemetryStateStore';
import { NormalizedEventParser } from '../services/normalizedEventParser';
import { EventDeduper } from '../services/eventDeduper';
import { EconomicsEnricher } from '../services/economicsEnricher';
import { SessionAggregator } from '../services/sessionAggregator';
import { AIEconomicEvent } from '../types/aiTelemetry';

const VERSION = 'v2.1.0-accounting';
const IDLE_AFTER_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 50;
const MAX_TIMELINE_EVENTS = 250;
const MAX_LIFECYCLE_HISTORY = 1000;
const WEBVIEW_UPDATE_DEBOUNCE_MS = 120;

/**
 * TelemetryService is the singleton runtime telemetry authority for BurnSight.
 *
 * Methodology summary:
 * - Accounting happens only on completed request boundaries.
 * - Deduplication is enforced by processedRequestIds.
 * - Economic fields remain undefined until real token telemetry is available.
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
  private readonly normalizedEventParser = new NormalizedEventParser();
  private readonly eventDeduper = new EventDeduper();
  private readonly economicsEnricher = new EconomicsEnricher();
  private readonly sessionAggregator = new SessionAggregator();

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

    const normalized = this.normalizedEventParser.parse({
      rawLine: event.rawLine,
      timestamp: event.timestamp,
      sourceFile: event.sourceFile ?? 'unknown',
      fileOffset: event.fileOffset,
    });
    if (!normalized) {
      return;
    }

    this.log.info(
      `[PARSER] parsed requestId=${normalized.requestId} model=${normalized.model} latency=${normalized.latencyMs} feature=${normalized.feature}`
    );

    if (!this.eventDeduper.shouldProcess(normalized)) {
      this.log.info(`[DEDUPE] skipped duplicate requestId=${normalized.requestId}`);
      return;
    }

    const enriched = this.economicsEnricher.enrich(normalized);
    this.log.info(
      `[ECONOMICS] ${enriched.pricingAvailable ? `pricing found model=${enriched.model}` : `pricing missing model=${enriched.model}`}`
    );

    const previousSessionState = this.sessionState;
    let accountedRequest = false;

    this.state = this.stateStore.update((prev) => {
      const next: TelemetryState = { ...prev };
      const now = event.timestamp;

      if (next.sessionStartedAt === null) {
        next.sessionStartedAt = now;
      }
      next.lastActivityAt = now;
      next.observedCharCount += event.observedChars;

      if (event.sessionArtifact && !next.sessionArtifacts.includes(event.sessionArtifact)) {
        next.sessionArtifacts = [...next.sessionArtifacts, event.sessionArtifact];
      }

      next.activeModel = enriched.model;
      if (!next.modelHistory.includes(enriched.model)) {
        next.modelHistory = [...next.modelHistory, enriched.model];
      }

      const lifecycle = this.upsertLifecycle(next, enriched.requestId, event, enriched);

      if (lifecycle.firstSeenAt === now && !lifecycle.accounted) {
        next.timeline = this.appendTimeline(next.timeline, {
          requestId: lifecycle.requestId,
          phase: 'request_start',
          model: lifecycle.model ?? enriched.model,
          sourceType: lifecycle.sourceType ?? enriched.feature,
          latencyMs: 0,
          success: false,
          estimatedCostUsd: 0,
          timestamp: now,
          rawLine: enriched.rawLine,
        });
      }

      if (next.processedRequestIds[enriched.requestId]) {
        this.log.info(`[DEDUPE] skipped duplicate requestId=${enriched.requestId}`);
        next.recentEvents = [event, ...next.recentEvents].slice(0, MAX_RECENT_EVENTS);
        return next;
      }

      lifecycle.seenRequestDone = true;
      lifecycle.completedAt = now;
      lifecycle.accounted = true;
      lifecycle.success = enriched.status === 'success';

      const sessionMetrics = this.sessionAggregator.consume(enriched);
      next.requestCount = sessionMetrics.totalRequests;
      next.successCount = sessionMetrics.successCount;
      next.cancelledCount = sessionMetrics.cancelledCount;
      next.errorCount = sessionMetrics.errorCount;
      next.totalLatencyMs = sessionMetrics.totalLatencyMs;
      next.averageLatencyMs = sessionMetrics.averageLatencyMs;
      next.requestsByFeature = { ...sessionMetrics.requestsByFeature };
      next.modelRequestCounts = { ...sessionMetrics.requestsByModel };
      next.retryRequests = sessionMetrics.retryRequests;

      next.latencies = [...next.latencies, enriched.latencyMs];
      next.modelLatencyStats = {
        ...next.modelLatencyStats,
        [enriched.model]: {
          totalMs: (next.modelLatencyStats[enriched.model]?.totalMs ?? 0) + enriched.latencyMs,
          count: (next.modelLatencyStats[enriched.model]?.count ?? 0) + 1,
        },
      };

      next.processedRequestIds = {
        ...next.processedRequestIds,
        [enriched.requestId]: true,
      };

      next.timeline = this.appendTimeline(next.timeline, {
        requestId: enriched.requestId,
        phase: 'request_complete',
        model: enriched.model,
        sourceType: enriched.feature,
        latencyMs: enriched.latencyMs,
        success: enriched.status === 'success',
        estimatedCostUsd: enriched.estimatedCostUsd ?? 0,
        timestamp: now,
        rawLine: enriched.rawLine,
      });
      next.recentEvents = [event, ...next.recentEvents].slice(0, MAX_RECENT_EVENTS);

      accountedRequest = true;
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

    if (accountedRequest) {
      this.log.info(
        `[SESSION] totalRequests=${this.state.requestCount} avgLatency=${Math.round(this.state.averageLatencyMs)}ms retryRequests=${this.state.retryRequests}`
      );
    }

    this.bus.emit('telemetry.updated', {
      event,
      state: this.state,
      snapshot: this.latestSnapshot,
    });

    this.emitSnapshotChannels(accountedRequest);
  }

  private upsertLifecycle(
    state: TelemetryState,
    requestId: string,
    event: CopilotLogEvent,
    normalized?: AIEconomicEvent
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
          accounted: false,
        };

    if (normalized?.model ?? event.model) {
      lifecycle.model = normalized?.model ?? event.model;
    }
    if (normalized?.latencyMs !== undefined || event.latencyMs !== undefined) {
      lifecycle.latencyMs = normalized?.latencyMs ?? event.latencyMs;
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
    if (normalized?.feature ?? event.sourceType) {
      lifecycle.sourceType = normalized?.feature ?? event.sourceType;
    }
    if (normalized?.status) {
      lifecycle.success = normalized.status === 'success';
    } else if (event.success !== undefined) {
      lifecycle.success = event.success;
    }
    if (event.requestDone) {
      lifecycle.seenRequestDone = true;
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

  private appendTimeline(
    timeline: SessionTimelineEvent[],
    event: SessionTimelineEvent
  ): SessionTimelineEvent[] {
    return [...timeline, event].slice(-MAX_TIMELINE_EVENTS);
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

      this.emitTelemetryAndWebview();
    }, IDLE_AFTER_MS);
  }

  private emitSnapshotChannels(includeStatusBarUpdate: boolean): void {
    this.bus.emit('telemetry.snapshot', this.latestSnapshot);
    this.scheduleWebviewUpdate();
    if (includeStatusBarUpdate) {
      this.bus.emit('statusbar.update', this.latestSnapshot);
    }
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

    const averageLatency = state.averageLatencyMs;

    const modelRows: string[][] = hasTelemetry
      ? state.modelHistory.map((modelName) => {
          const modelRequests = state.modelRequestCounts[modelName] ?? 0;
          const modelLatency = state.modelLatencyStats[modelName];
          const avgModelLatency = modelLatency
            ? Math.round(modelLatency.totalMs / Math.max(1, modelLatency.count))
            : 0;
          return [modelName, formatInteger(modelRequests), `${avgModelLatency}ms`];
        })
      : [['—', '0', '0ms']];

    const finishReasonRows = Object.entries(state.finishReasons).length
      ? Object.entries(state.finishReasons)
          .sort((left, right) => right[1] - left[1])
          .map(([reason, count]) => ({
            label: reason,
            value: formatInteger(count),
          }))
      : [{ label: 'no-data', value: '0' }];

    const mostUsedModel = this.getMostUsedModel(state.modelRequestCounts);
    const topWorkflow = this.getMostUsedModel(state.requestsByFeature);
    const distribution = this.formatModelDistribution(state.modelRequestCounts, state.requestCount);

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
        id: 'requestCount',
        label: 'Request Count',
        confidence: ConfidenceLevel.REAL,
        value: state.requestCount,
        formatted: formatInteger(state.requestCount),
        notes: 'Counted once per requestId after completion accounting.',
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
        notes: 'Average of observed/completed request latency values.',
      },
      {
        id: 'estimatedTotalTokens',
        label: 'Estimated Total Tokens',
        confidence: ConfidenceLevel.HEURISTIC,
        value: 'n/a',
        formatted: 'n/a',
        notes: 'Pending real token telemetry integration.',
      },
      {
        id: 'estimatedCost',
        label: 'Estimated Economics',
        confidence: ConfidenceLevel.HEURISTIC,
        value: 'n/a',
        formatted: 'n/a',
        notes: 'Pending real token telemetry integration.',
      },
      {
        id: 'estimatedBurnRate',
        label: 'Burn Velocity',
        confidence: ConfidenceLevel.HEURISTIC,
        value: 'n/a',
        formatted: 'n/a',
        notes: 'Pending real token telemetry integration.',
      },
      {
        id: 'averageRequestCost',
        label: 'Avg Request Cost',
        confidence: ConfidenceLevel.HEURISTIC,
        value: 'n/a',
        formatted: 'n/a',
        notes: 'Pending real token telemetry integration.',
      },
    ];

    const recentEvents = state.recentEvents
      .slice(0, 10)
      .map((item) => `[${new Date(item.timestamp).toISOString().slice(11, 23)}] ${item.raw}`);

    const timelineRows = state.timeline
      .slice(-8)
      .map((entry) => [
        new Date(entry.timestamp).toISOString().slice(11, 19),
        entry.phase,
        entry.model,
        entry.latencyMs > 0 ? `${entry.latencyMs}ms` : '—',
        entry.estimatedCostUsd > 0 ? formatCurrency(entry.estimatedCostUsd) : '$0.00',
      ]);

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
          title: 'SESSION OVERVIEW',
          mainValue: formatInteger(state.requestCount),
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
              label: 'AVG LATENCY',
              value: averageLatency > 0 ? `${Math.round(averageLatency)}ms` : '0ms',
            },
            {
              label: 'RETRY REQUESTS',
              value: formatInteger(state.retryRequests),
              accent: 'orange',
            },
          ],
        },
        {
          id: 'models',
          kind: 'table',
          title: 'MODEL ANALYTICS (REAL)',
          columns: ['MODEL', 'REQS', 'AVG LAT'],
          rows: modelRows,
        },
        {
          id: 'model-insights',
          kind: 'list',
          title: 'WORKFLOW INSIGHTS',
          tone: 'neutral',
          rows: [
            {
              label: 'MOST USED MODEL',
              value: mostUsedModel,
            },
            {
              label: 'TOP WORKFLOW',
              value: topWorkflow,
              accent: 'orange',
            },
            {
              label: 'REQUEST DISTRIBUTION',
              value: distribution,
            },
          ],
          footerLabel: 'RETRY REQUESTS',
          footerValue: formatInteger(state.retryRequests),
        },
        {
          id: 'lifecycle',
          kind: 'list',
          title: 'REQUEST LIFECYCLE (REAL)',
          tone: 'ok',
          rows: finishReasonRows,
          footerLabel: 'SESSION ARTIFACTS',
          footerValue: formatInteger(state.sessionArtifacts.length),
        },
        {
          id: 'timeline',
          kind: 'table',
          title: 'SESSION TIMELINE',
          columns: ['TIME', 'PHASE', 'MODEL', 'LAT', 'COST'],
          rows: timelineRows.length > 0 ? timelineRows : [['—', '—', '—', '—', '$0.00']],
        },
      ],
    };
  }

  private getMostUsedModel(counts: Record<string, number>): string {
    const sorted = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    return sorted[0]?.[0] ?? 'none';
  }

  private getMostExpensiveModel(costs: Record<string, number>): string {
    const sorted = Object.entries(costs).sort((left, right) => right[1] - left[1]);
    return sorted[0]?.[0] ?? 'none';
  }

  private formatModelDistribution(
    counts: Record<string, number>,
    totalRequests: number
  ): string {
    if (totalRequests <= 0) {
      return 'none';
    }

    const parts = Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([model, count]) => `${model}:${Math.round((count / totalRequests) * 100)}%`);

    return parts.join(' | ');
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
      requestsByFeature: {},
      latencies: [],
      totalLatencyMs: 0,
      averageLatencyMs: 0,
      successCount: 0,
      cancelledCount: 0,
      errorCount: 0,
      retryRequests: 0,
      requestIds: [],
      finishReasons: {},
      sessionArtifacts: [],
      processedRequestIds: {},
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
      timeline: [],
      modelLatencyStats: {},
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
