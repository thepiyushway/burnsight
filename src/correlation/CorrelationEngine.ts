import { RawSignal } from '../domain/RawSignal';
import {
  InteractionTrace,
  InteractionType,
  Span,
  WorkflowBreakdown,
} from '../domain/InteractionTrace';
import { ConfidenceLevel } from '../domain/ConfidenceLevel';

/** Mutable in-flight accumulator; becomes an InteractionTrace on completion. */
interface InFlightTrace {
  traceId: string;
  sessionId: string;
  startedAt: number;
  signals: RawSignal[];
  spans: Span[];
  modelsUsed: Set<string>;
  retryCount: number;
  escalationCount: number;
}

type TraceCompletionListener = (trace: InteractionTrace, endSignal: RawSignal) => void;

/**
 * THE HEART OF THE BURNSIGHT PLATFORM.
 *
 * The CorrelationEngine converts noisy runtime signals into canonical
 * InteractionTraces.  ONE trace = ONE logical user interaction, regardless
 * of the number of internal model calls, retries, wrapper invocations, or
 * orchestration hops that occurred underneath.
 *
 * Example:
 *   User: "write quicksort in python"
 *   Observed signals:
 *     - title generation (model-detected)
 *     - progress messages (model-detected)
 *     - edit agent orchestration (request-start)
 *     - retry (retry)
 *     - escalation: gpt-4o-mini → gpt-5.3-codex (escalation / model chain)
 *     - final completion (request-end)
 *   Result: ONE InteractionTrace with 5 spans
 *
 * Correlation dimensions used:
 *   - requestId (primary key from provider)
 *   - model chain order (escalation detection)
 *   - retry count (from signal metadata)
 *   - workflow/feature label
 *
 * The engine does NOT compute economics — those are applied by EconomicsEngine
 * after a trace completes.
 *
 * Thread safety: synchronous; designed for the VS Code extension host event loop.
 */
export class CorrelationEngine {
  private readonly inFlight = new Map<string, InFlightTrace>();
  private readonly completionListeners: TraceCompletionListener[] = [];

  constructor(private readonly sessionId: string) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Ingest a raw signal.  May synchronously invoke completion listeners when
   * a 'request-end' signal closes a trace.
   */
  public ingest(signal: RawSignal): void {
    const requestId = signal.requestId ?? `orphan-${signal.signalId}`;

    switch (signal.type) {
      case 'request-start':
        this.handleStart(requestId, signal);
        break;
      case 'model-detected':
        this.handleModelDetected(requestId, signal);
        break;
      case 'retry':
        this.handleRetry(requestId, signal);
        break;
      case 'escalation':
        this.handleEscalation(requestId, signal);
        break;
      case 'request-end':
        this.handleEnd(requestId, signal);
        break;
      default:
        this.handleOther(requestId, signal);
    }
  }

  /**
   * Register a listener for completed InteractionTraces.
   * The endSignal is provided alongside the trace so that EconomicsEngine can
   * access the raw metadata needed for heuristic token estimation.
   */
  public onTraceCompleted(listener: TraceCompletionListener): { dispose: () => void } {
    this.completionListeners.push(listener);
    return {
      dispose: () => {
        const idx = this.completionListeners.indexOf(listener);
        if (idx >= 0) {
          this.completionListeners.splice(idx, 1);
        }
      },
    };
  }

  /** Number of currently open (unfinished) traces — useful for diagnostics. */
  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  // --------------------------------------------------------------------------
  // Signal handlers
  // --------------------------------------------------------------------------

  private handleStart(requestId: string, signal: RawSignal): void {
    if (!this.inFlight.has(requestId)) {
      this.inFlight.set(requestId, this.createInFlight(requestId, signal));
    }
  }

  private handleModelDetected(requestId: string, signal: RawSignal): void {
    const trace = this.getOrCreate(requestId, signal);
    if (signal.model) {
      trace.modelsUsed.add(signal.model);
    }
    trace.signals.push(signal);
  }

  private handleRetry(requestId: string, signal: RawSignal): void {
    const trace = this.getOrCreate(requestId, signal);
    trace.retryCount += signal.retryCount ?? 1;
    trace.signals.push(signal);
  }

  private handleEscalation(requestId: string, signal: RawSignal): void {
    const trace = this.getOrCreate(requestId, signal);
    trace.escalationCount += signal.escalationCount ?? 1;
    trace.signals.push(signal);
  }

  private handleEnd(requestId: string, signal: RawSignal): void {
    const trace = this.getOrCreate(requestId, signal);
    trace.signals.push(signal);

    // Build spans from the model chain embedded in the end signal.
    // The canonical GitHub Copilot log line already contains the full chain.
    const modelChain = signal.modelChain ?? (signal.model ? [signal.model] : []);
    const totalLatency = signal.latencyMs ?? 0;
    const perSpanLatency = modelChain.length > 0
      ? Math.floor(totalLatency / modelChain.length)
      : totalLatency;

    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];
      const spanType: Span['type'] = i === 0 ? 'model-call' : 'escalation';
      trace.spans.push({
        spanId: `${requestId}-span-${i}`,
        type: spanType,
        model,
        workflow: signal.feature,
        startedAt: trace.startedAt + i * perSpanLatency,
        completedAt: trace.startedAt + (i + 1) * perSpanLatency,
        latencyMs: perSpanLatency,
        metadata: {},
      });
      trace.modelsUsed.add(model);
    }

    // Reconcile escalation/retry counts with end signal
    if (modelChain.length > 1) {
      trace.escalationCount = Math.max(trace.escalationCount, modelChain.length - 1);
    }
    if (signal.retryCount && signal.retryCount > 0) {
      trace.retryCount = Math.max(trace.retryCount, signal.retryCount);
    }

    const completedTrace = this.finalizeTrace(trace, signal);
    this.inFlight.delete(requestId);

    for (const listener of this.completionListeners) {
      listener(completedTrace, signal);
    }
  }

  private handleOther(requestId: string, signal: RawSignal): void {
    const existing = this.inFlight.get(requestId);
    if (existing) {
      existing.signals.push(signal);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getOrCreate(requestId: string, signal: RawSignal): InFlightTrace {
    if (!this.inFlight.has(requestId)) {
      this.inFlight.set(requestId, this.createInFlight(requestId, signal));
    }
    return this.inFlight.get(requestId)!;
  }

  private createInFlight(requestId: string, signal: RawSignal): InFlightTrace {
    return {
      traceId: requestId,
      sessionId: this.sessionId,
      startedAt: signal.timestamp,
      signals: [],
      spans: [],
      modelsUsed: new Set<string>(),
      retryCount: 0,
      escalationCount: 0,
    };
  }

  private finalizeTrace(inFlight: InFlightTrace, endSignal: RawSignal): InteractionTrace {
    const workflowBreakdown = this.buildWorkflowBreakdown(inFlight.spans, endSignal.feature);
    const interactionType = this.classifyInteractionType(endSignal.feature ?? '');
    const modelsUsed = [...inFlight.modelsUsed];

    return {
      traceId: inFlight.traceId,
      sessionId: inFlight.sessionId,
      interactionType,
      startedAt: inFlight.startedAt,
      completedAt: endSignal.timestamp,
      spans: [...inFlight.spans],
      modelsUsed,
      // Economics fields intentionally zero — EconomicsEngine fills them
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      retryCount: inFlight.retryCount,
      escalationCount: inFlight.escalationCount,
      workflowBreakdown,
      confidence: ConfidenceLevel.HEURISTIC,
    };
  }

  private buildWorkflowBreakdown(
    spans: Span[],
    defaultWorkflow?: string,
  ): WorkflowBreakdown[] {
    const featureMap = new Map<string, { spanCount: number; cost: number; tokens: number }>();

    for (const span of spans) {
      const wf = span.workflow ?? defaultWorkflow ?? 'unknown';
      const entry = featureMap.get(wf) ?? { spanCount: 0, cost: 0, tokens: 0 };
      entry.spanCount++;
      entry.cost += span.estimatedCostUsd ?? 0;
      entry.tokens +=
        (span.estimatedInputTokens ?? 0) + (span.estimatedOutputTokens ?? 0);
      featureMap.set(wf, entry);
    }

    // Always include at least the default workflow even if no spans yet
    if (featureMap.size === 0 && defaultWorkflow) {
      featureMap.set(defaultWorkflow, { spanCount: 1, cost: 0, tokens: 0 });
    }

    return [...featureMap.entries()].map(([workflow, m]) => ({
      workflow,
      spanCount: m.spanCount,
      estimatedCostUsd: m.cost,
      estimatedTokens: m.tokens,
    }));
  }

  private classifyInteractionType(feature: string): InteractionType {
    const lower = feature.toLowerCase();
    if (
      lower.includes('editagent') ||
      lower.includes('agent/apply') ||
      lower.includes('panel/edit')
    ) {
      return 'edit-agent';
    }
    if (lower.includes('inline') || lower.includes('completion')) {
      return 'inline-completion';
    }
    if (lower.includes('tool') || lower.includes('subagent')) {
      return 'tool-assisted';
    }
    return 'chat';
  }
}
