import { InteractionTrace } from '../domain/InteractionTrace';
import {
  AggregateMetrics,
  ModelMetrics,
  WorkflowMetrics,
  SessionTelemetry,
} from '../domain/SessionTelemetry';
import { ConfidenceLevel } from '../domain/ConfidenceLevel';

/**
 * Escalation chain record — used for per-session analytics.
 */
export interface EscalationChainRecord {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly estimatedCostUsd: number;
}

/**
 * Per-workflow cost breakdown with semantic enrichment.
 */
export interface WorkflowCostEntry {
  readonly workflow: string;
  readonly interactionCount: number;
  readonly internalOperations: number;
  readonly estimatedCostUsd: number;
  readonly orchestrationOverheadCostUsd: number;
  readonly averageLatencyMs: number;
}

/**
 * Full session analytics — derived from InteractionTraces.
 * Richer than AggregateMetrics; not persisted (recomputed on demand).
 */
export interface SessionAnalytics {
  // ---- Core
  readonly totalInteractions: number;
  readonly totalInternalOperations: number;
  readonly estimatedTotalCostUsd: number;
  readonly estimatedTotalInputTokens: number;
  readonly estimatedTotalOutputTokens: number;
  readonly averageLatencyMs: number;
  readonly totalLatencyMs: number;

  // ---- Semantic
  readonly orchestrationOverheadUsd: number;
  readonly orchestrationOverheadPct: number;
  readonly retryAmplificationUsd: number;
  readonly retryAmplificationPct: number;
  readonly hiddenInferenceCount: number;
  readonly hiddenInferenceCostUsd: number;
  readonly escalationChains: readonly EscalationChainRecord[];
  readonly workflowCostBreakdown: readonly WorkflowCostEntry[];
  readonly modelCostDistribution: Readonly<Record<string, ModelMetrics>>;
  readonly dominantWorkflow: string;
  readonly dominantModel: string;

  // ---- Confidence
  readonly confidence: ConfidenceLevel;
}

/**
 * AggregateTelemetryEngine — the analytics brain of BurnSight.
 *
 * Derives meaningful session-level analytics from a list of InteractionTraces.
 * This is the CORRECT place for any cross-trace aggregation logic.
 *
 * Differences from SessionStore.computeAggregateMetrics():
 *   - AggregateTelemetryEngine uses semantic data (InteractionSemantics) when
 *     available — it properly attributes orchestration overhead and retry cost.
 *   - SessionStore.computeAggregateMetrics() is the fast path used on every
 *     trace append for persisted metrics; it does NOT use semantics.
 *   - AggregateTelemetryEngine is called by SessionStore for the full
 *     AggregateMetrics computation when semantics ARE available.
 *
 * STATELESS — call computeMetrics() on any slice of interactions.
 */
export class AggregateTelemetryEngine {
  /**
   * Compute full AggregateMetrics from a set of interactions.
   * This is the primary method called by SessionStore.
   */
  public computeMetrics(
    interactions: readonly InteractionTrace[],
    sessionStartedAt: number,
  ): AggregateMetrics {
    const mutableModel: Record<
      string,
      {
        requestCount: number;
        estimatedInputTokens: number;
        estimatedOutputTokens: number;
        estimatedCostUsd: number;
        totalLatencyMs: number;
      }
    > = {};

    const mutableWorkflow: Record<
      string,
      {
        requestCount: number;
        estimatedInputTokens: number;
        estimatedOutputTokens: number;
        estimatedCostUsd: number;
      }
    > = {};

    let totalInteractions = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let totalLatencyMs = 0;
    let retryCount = 0;
    let escalationCount = 0;
    let totalInternalOperations = 0;
    let hiddenInferenceCount = 0;
    let orchestrationOverheadCostUsd = 0;
    let retryAmplificationCostUsd = 0;

    for (const trace of interactions) {
      totalInteractions++;
      totalInputTokens += trace.estimatedInputTokens;
      totalOutputTokens += trace.estimatedOutputTokens;
      totalCostUsd += trace.estimatedCostUsd;
      retryCount += trace.retryCount;
      escalationCount += trace.escalationCount;

      const latencyMs = trace.completedAt
        ? trace.completedAt - trace.startedAt
        : 0;
      totalLatencyMs += latencyMs;

      // Semantic counters — populated when TraceClassifier ran
      const semantics = trace.semantics;
      if (semantics) {
        totalInternalOperations += semantics.internalOperationCount;
        hiddenInferenceCount += semantics.hiddenInferenceCount;
        orchestrationOverheadCostUsd +=
          trace.estimatedCostUsd * semantics.orchestrationOverheadRatio;
        retryAmplificationCostUsd +=
          trace.estimatedCostUsd * Math.max(0, semantics.retryAmplification - 1);
      } else {
        // Fall back to span count when semantics are absent
        totalInternalOperations += trace.spans.length;
      }

      // Model breakdown — evenly distribute across modelsUsed
      const modelsCount = trace.modelsUsed.length || 1;
      for (const model of trace.modelsUsed) {
        if (!mutableModel[model]) {
          mutableModel[model] = {
            requestCount: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostUsd: 0,
            totalLatencyMs: 0,
          };
        }
        const m = mutableModel[model];
        m.requestCount++;
        m.estimatedInputTokens += trace.estimatedInputTokens / modelsCount;
        m.estimatedOutputTokens += trace.estimatedOutputTokens / modelsCount;
        m.estimatedCostUsd += trace.estimatedCostUsd / modelsCount;
        m.totalLatencyMs += latencyMs / modelsCount;
      }

      // Workflow breakdown
      for (const wb of trace.workflowBreakdown) {
        if (!mutableWorkflow[wb.workflow]) {
          mutableWorkflow[wb.workflow] = {
            requestCount: 0,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostUsd: 0,
          };
        }
        const wf = mutableWorkflow[wb.workflow];
        wf.requestCount += wb.spanCount;
        wf.estimatedCostUsd += wb.estimatedCostUsd;
        wf.estimatedInputTokens += wb.estimatedTokens / 2;
        wf.estimatedOutputTokens += wb.estimatedTokens / 2;
      }
    }

    const averageLatencyMs =
      totalInteractions > 0 ? totalLatencyMs / totalInteractions : 0;
    const elapsedMs = Math.max(1, Date.now() - sessionStartedAt);
    const estimatedBurnRatePerHour = totalCostUsd / (elapsedMs / (60 * 60 * 1000));
    const retryCostPercentage =
      totalCostUsd > 0 ? (retryAmplificationCostUsd / totalCostUsd) * 100 : 0;
    const orchestrationOverheadRatio =
      totalCostUsd > 0
        ? Math.min(1, orchestrationOverheadCostUsd / totalCostUsd)
        : 0;

    return {
      totalInteractions,
      successCount: 0, // Would require signal-level status tracking
      cancelledCount: 0,
      errorCount: 0,
      retryCount,
      escalationCount,
      estimatedTotalInputTokens: totalInputTokens,
      estimatedTotalOutputTokens: totalOutputTokens,
      estimatedTotalCostUsd: totalCostUsd,
      estimatedBurnRatePerHour,
      averageLatencyMs,
      totalLatencyMs,
      modelBreakdown: mutableModel,
      workflowBreakdown: mutableWorkflow,
      orchestrationOverheadCostUsd,
      retryAmplificationCostUsd,
      retryCostPercentage: parseFloat(retryCostPercentage.toFixed(2)),
      totalInternalOperations,
      hiddenInferenceCount,
      orchestrationOverheadRatio: parseFloat(orchestrationOverheadRatio.toFixed(3)),
      confidence: ConfidenceLevel.HEURISTIC,
    };
  }

  /**
   * Derive rich SessionAnalytics from a session.
   * NOT used for persistence — use this for UI analysis and reporting.
   */
  public analyzeSession(session: SessionTelemetry): SessionAnalytics {
    const agg = session.aggregateMetrics;
    const interactions = session.interactions;

    const escalationMap = this.buildEscalationChains(interactions);
    const workflowBreakdown = this.buildWorkflowBreakdown(interactions);

    const dominantWorkflow =
      this.getKeyWithHighestValue(
        Object.fromEntries(workflowBreakdown.map((w) => [w.workflow, w.estimatedCostUsd])),
      ) ?? 'unknown';

    const dominantModel =
      this.getKeyWithHighestValue(
        Object.fromEntries(
          Object.entries(agg.modelBreakdown).map(([k, v]) => [k, v.estimatedCostUsd]),
        ),
      ) ?? 'unknown';

    return {
      totalInteractions: agg.totalInteractions,
      totalInternalOperations: agg.totalInternalOperations,
      estimatedTotalCostUsd: agg.estimatedTotalCostUsd,
      estimatedTotalInputTokens: agg.estimatedTotalInputTokens,
      estimatedTotalOutputTokens: agg.estimatedTotalOutputTokens,
      averageLatencyMs: agg.averageLatencyMs,
      totalLatencyMs: agg.totalLatencyMs,
      orchestrationOverheadUsd: agg.orchestrationOverheadCostUsd,
      orchestrationOverheadPct: parseFloat(
        (agg.orchestrationOverheadRatio * 100).toFixed(1),
      ),
      retryAmplificationUsd: agg.retryAmplificationCostUsd,
      retryAmplificationPct: parseFloat(agg.retryCostPercentage.toFixed(1)),
      hiddenInferenceCount: agg.hiddenInferenceCount,
      hiddenInferenceCostUsd: this.estimateHiddenInferenceCost(interactions),
      escalationChains: escalationMap,
      workflowCostBreakdown: workflowBreakdown,
      modelCostDistribution: agg.modelBreakdown,
      dominantWorkflow,
      dominantModel,
      confidence: agg.confidence,
    };
  }

  /**
   * Return an empty AggregateMetrics — used for session initialization.
   */
  public emptyMetrics(): AggregateMetrics {
    return {
      totalInteractions: 0,
      successCount: 0,
      cancelledCount: 0,
      errorCount: 0,
      retryCount: 0,
      escalationCount: 0,
      estimatedTotalInputTokens: 0,
      estimatedTotalOutputTokens: 0,
      estimatedTotalCostUsd: 0,
      estimatedBurnRatePerHour: 0,
      averageLatencyMs: 0,
      totalLatencyMs: 0,
      modelBreakdown: {},
      workflowBreakdown: {},
      orchestrationOverheadCostUsd: 0,
      retryAmplificationCostUsd: 0,
      retryCostPercentage: 0,
      totalInternalOperations: 0,
      hiddenInferenceCount: 0,
      orchestrationOverheadRatio: 0,
      confidence: ConfidenceLevel.HEURISTIC,
    };
  }

  // --------------------------------------------------------------------------
  // Private analytics helpers
  // --------------------------------------------------------------------------

  private buildEscalationChains(
    interactions: readonly InteractionTrace[],
  ): EscalationChainRecord[] {
    const chainMap: Map<string, { count: number; cost: number }> = new Map();

    for (const trace of interactions) {
      const chain = trace.semantics?.escalationChain ?? [];
      if (chain.length < 2) {continue;}

      for (let i = 0; i < chain.length - 1; i++) {
        const key = `${chain[i]}→${chain[i + 1]}`;
        const existing = chainMap.get(key) ?? { count: 0, cost: 0 };
        existing.count++;
        existing.cost += trace.estimatedCostUsd / (chain.length - 1);
        chainMap.set(key, existing);
      }
    }

    return [...chainMap.entries()].map(([key, data]) => {
      const [from, to] = key.split('→');
      return {
        from,
        to,
        count: data.count,
        estimatedCostUsd: data.cost,
      };
    }).sort((a, b) => b.count - a.count);
  }

  private buildWorkflowBreakdown(
    interactions: readonly InteractionTrace[],
  ): WorkflowCostEntry[] {
    const wfMap: Map<
      string,
      {
        interactionCount: number;
        internalOps: number;
        cost: number;
        overhead: number;
        latency: number;
      }
    > = new Map();

    for (const trace of interactions) {
      const latency = trace.completedAt ? trace.completedAt - trace.startedAt : 0;
      const semantics = trace.semantics;
      const dominant = semantics?.dominantWorkflow ?? trace.workflowBreakdown[0]?.workflow ?? 'unknown';

      const existing = wfMap.get(dominant) ?? {
        interactionCount: 0,
        internalOps: 0,
        cost: 0,
        overhead: 0,
        latency: 0,
      };

      existing.interactionCount++;
      existing.internalOps += semantics?.internalOperationCount ?? trace.spans.length;
      existing.cost += trace.estimatedCostUsd;
      existing.overhead += trace.estimatedCostUsd * (semantics?.orchestrationOverheadRatio ?? 0);
      existing.latency += latency;
      wfMap.set(dominant, existing);
    }

    return [...wfMap.entries()]
      .map(([workflow, data]) => ({
        workflow,
        interactionCount: data.interactionCount,
        internalOperations: data.internalOps,
        estimatedCostUsd: data.cost,
        orchestrationOverheadCostUsd: data.overhead,
        averageLatencyMs: data.interactionCount > 0 ? data.latency / data.interactionCount : 0,
      }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  }

  private estimateHiddenInferenceCost(
    interactions: readonly InteractionTrace[],
  ): number {
    let total = 0;
    for (const trace of interactions) {
      const semantics = trace.semantics;
      if (!semantics) {continue;}
      const hiddenSpans = semantics.classifiedSpans.filter(
        (s) => s.category === 'hidden-inference',
      );
      total += hiddenSpans.reduce((sum, s) => sum + (s.estimatedCostUsd ?? 0), 0);
    }
    return total;
  }

  private getKeyWithHighestValue(obj: Record<string, number>): string | undefined {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0];
  }
}
