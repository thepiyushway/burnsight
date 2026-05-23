import * as vscode from 'vscode';
import { ProviderAdapter } from './ProviderAdapter';
import { RawSignal } from '../domain/RawSignal';
import { EventBus } from '../utils/EventBus';
import { BurnSightEvents, CopilotLogEvent } from '../telemetry/types';
import { NormalizedEventParser } from '../services/normalizedEventParser';
import { EventDeduper } from '../services/eventDeduper';

/**
 * Translates GitHub Copilot log events into canonical RawSignals.
 *
 * Signal extraction strategy:
 *   The Copilot canonical log line has the form:
 *     ccreq:xxx.copilotmd | success | model1 -> model2 | 1420ms | [feature]
 *
 *   Each such line represents ONE complete request lifecycle.  The model chain
 *   encodes all escalation hops that happened internally.  A single log line
 *   therefore maps to ONE 'request-end' RawSignal carrying the full chain.
 *
 * Deduplication:
 *   Uses EventDeduper (requestId + sourceFile + fileOffset) to suppress
 *   duplicate emissions from file-system watcher re-reads.
 *
 * This adapter does NOT compute metrics, costs, or token counts.
 */
export class GitHubCopilotAdapter implements ProviderAdapter {
  readonly providerId = 'github-copilot';

  private readonly callbacks: Array<(signal: RawSignal) => void> = [];
  private subscription: vscode.Disposable | undefined;
  private readonly normalizedParser = new NormalizedEventParser();
  private readonly deduper = new EventDeduper();

  constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async start(): Promise<void> {
    this.subscription = this.bus.on('copilot.request', (event) => {
      this.handleCopilotEvent(event);
    });
    this.log.info('[CopilotAdapter] started');
  }

  async stop(): Promise<void> {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.callbacks.length = 0;
    this.log.info('[CopilotAdapter] stopped');
  }

  onSignal(callback: (signal: RawSignal) => void): { dispose: () => void } {
    this.callbacks.push(callback);
    return {
      dispose: () => {
        const idx = this.callbacks.indexOf(callback);
        if (idx >= 0) {
          this.callbacks.splice(idx, 1);
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private handleCopilotEvent(event: CopilotLogEvent): void {
    // Self-source guard: never ingest our own telemetry
    if ((event.sourceFile ?? '').toLowerCase().includes('burnsight')) {
      return;
    }

    const normalized = this.normalizedParser.parse({
      rawLine: event.rawLine,
      timestamp: event.timestamp,
      sourceFile: event.sourceFile ?? 'unknown',
      fileOffset: event.fileOffset,
    });

    if (!normalized) {
      // Non-canonical lines carry no structured signal
      return;
    }

    if (!this.deduper.shouldProcess(normalized)) {
      this.log.info(`[CopilotAdapter] dedupe skip requestId=${normalized.requestId}`);
      return;
    }

    const signal = this.buildSignal(event, normalized);
    this.log.info(
      `[CopilotAdapter] signal type=${signal.type} requestId=${signal.requestId} model=${signal.model ?? 'unknown'} latency=${signal.latencyMs ?? 0}ms`,
    );

    for (const cb of this.callbacks) {
      cb(signal);
    }
  }

  private buildSignal(
    event: CopilotLogEvent,
    normalized: NonNullable<ReturnType<NormalizedEventParser['parse']>>,
  ): RawSignal {
    return {
      signalId: `${normalized.requestId}-${event.timestamp}`,
      source: this.providerId,
      timestamp: event.timestamp,
      type: 'request-end',
      requestId: normalized.requestId,
      model: normalized.model,
      modelChain: normalized.modelChain,
      latencyMs: normalized.latencyMs,
      feature: normalized.feature,
      status: normalized.status,
      retryCount: normalized.retryCount,
      escalationCount: normalized.escalationCount,
      isRetry: normalized.isRetry,
      rawLine: event.rawLine,
      metadata: {
        sourceFile: event.sourceFile,
        fileOffset: event.fileOffset,
        hasEscalation: normalized.hasEscalation,
        routedFromModel: normalized.routedFromModel,
      },
    };
  }
}
