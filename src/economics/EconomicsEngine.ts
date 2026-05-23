import { InteractionTrace, Span, WorkflowBreakdown } from '../domain/InteractionTrace';
import { RawSignal } from '../domain/RawSignal';
import { ConfidenceLevel } from '../domain/ConfidenceLevel';
import { TokenEstimator } from './TokenEstimator';
import { CostEstimator } from './CostEstimator';
import { AIRequestEvent } from '../types/aiTelemetry';

/**
 * Enriches completed InteractionTraces with estimated token and cost data.
 *
 * The engine adapts a completed trace and its originating end signal into the
 * AIRequestEvent shape expected by TokenEstimator/CostEstimator, then
 * distributes the resulting economics across all spans proportionally by
 * observed span latency.
 *
 * All outputs carry ConfidenceLevel.HEURISTIC.  They are observability-grade
 * estimates, never billing truth.
 *
 * Cost formula:
 *   estimatedCost = (inputTokens / 1_000_000 × inputPrice)
 *                 + (outputTokens / 1_000_000 × outputPrice)
 */
export class EconomicsEngine {
  private readonly tokenEstimator = new TokenEstimator();
  private readonly costEstimator = new CostEstimator();

  /**
   * Returns a new InteractionTrace with all economics fields populated.
   * The original trace is not mutated.
   */
  public enrichTrace(trace: InteractionTrace, endSignal: RawSignal): InteractionTrace {
    const requestEvent = this.buildRequestEvent(trace, endSignal);
    if (!requestEvent) {
      return trace;
    }

    const tokenEstimate = this.tokenEstimator.estimate(requestEvent);
    const costEstimate = this.costEstimator.estimate(
      tokenEstimate.inputTokens,
      tokenEstimate.outputTokens,
      requestEvent.model,
    );

    const enrichedSpans = this.distributeToSpans(
      trace.spans as Span[],
      tokenEstimate.inputTokens,
      tokenEstimate.outputTokens,
      costEstimate.estimatedCostUsd,
    );

    const enrichedWorkflowBreakdown = this.enrichWorkflowBreakdown(
      trace.workflowBreakdown as WorkflowBreakdown[],
      enrichedSpans,
      costEstimate.estimatedCostUsd,
      tokenEstimate.totalTokens,
    );

    return {
      ...trace,
      spans: enrichedSpans,
      workflowBreakdown: enrichedWorkflowBreakdown,
      estimatedInputTokens: tokenEstimate.inputTokens,
      estimatedOutputTokens: tokenEstimate.outputTokens,
      estimatedCostUsd: costEstimate.estimatedCostUsd,
      confidence: ConfidenceLevel.HEURISTIC,
    };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private buildRequestEvent(
    trace: InteractionTrace,
    signal: RawSignal,
  ): AIRequestEvent | undefined {
    const model =
      signal.model ?? trace.modelsUsed[trace.modelsUsed.length - 1];
    if (!model) {
      return undefined;
    }

    const latencyMs =
      signal.latencyMs ??
      (trace.completedAt ? trace.completedAt - trace.startedAt : 1000);

    const feature =
      signal.feature ??
      (trace.workflowBreakdown.length > 0
        ? trace.workflowBreakdown[0].workflow
        : 'unknown');

    return {
      timestamp: trace.startedAt,
      provider: 'github-copilot',
      requestId: trace.traceId,
      status: signal.status ?? 'success',
      model,
      modelChain: signal.modelChain ?? [...trace.modelsUsed],
      hasEscalation: trace.escalationCount > 0,
      escalationCount: trace.escalationCount,
      latencyMs,
      feature,
      isRetry: trace.retryCount > 0,
      retryCount: trace.retryCount,
      rawLine: signal.rawLine ?? '',
      sourceFile: (signal.metadata?.sourceFile as string | undefined) ?? '',
      fileOffset: (signal.metadata?.fileOffset as number | undefined) ?? 0,
    };
  }

  /**
   * Distribute total token/cost economics across spans weighted by latency.
   * Longer-running spans receive proportionally more tokens (proxy for work done).
   */
  private distributeToSpans(
    spans: Span[],
    totalInput: number,
    totalOutput: number,
    totalCost: number,
  ): Span[] {
    if (spans.length === 0) {
      return spans;
    }

    const totalLatency = spans.reduce((s, span) => s + (span.latencyMs ?? 1), 0) || 1;

    return spans.map((span) => {
      const weight = (span.latencyMs ?? 1) / totalLatency;
      return {
        ...span,
        estimatedInputTokens: Math.max(1, Math.round(totalInput * weight)),
        estimatedOutputTokens: Math.max(1, Math.round(totalOutput * weight)),
        estimatedCostUsd: totalCost * weight,
      };
    });
  }

  /** Rebuild workflow breakdown with enriched economics from spans. */
  private enrichWorkflowBreakdown(
    breakdown: WorkflowBreakdown[],
    enrichedSpans: Span[],
    totalCost: number,
    totalTokens: number,
  ): WorkflowBreakdown[] {
    return breakdown.map((wb) => {
      const relevantSpans = enrichedSpans.filter((s) => s.workflow === wb.workflow);
      if (relevantSpans.length === 0) {
        return {
          ...wb,
          estimatedCostUsd: totalCost,
          estimatedTokens: totalTokens,
        };
      }
      return {
        ...wb,
        estimatedCostUsd: relevantSpans.reduce(
          (s, sp) => s + (sp.estimatedCostUsd ?? 0),
          0,
        ),
        estimatedTokens: relevantSpans.reduce(
          (s, sp) =>
            s + (sp.estimatedInputTokens ?? 0) + (sp.estimatedOutputTokens ?? 0),
          0,
        ),
      };
    });
  }
}
