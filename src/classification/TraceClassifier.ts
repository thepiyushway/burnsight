import {
  InteractionTrace,
  InteractionSemantics,
  ClassifiedSpan,
  Span,
  SpanCategory,
} from '../domain/InteractionTrace';

// ---------------------------------------------------------------------------
// Category calibration multipliers — used by EconomicsCalibrator to scale
// raw heuristic cost estimates into believable values.
// ---------------------------------------------------------------------------

/** Per-category cost calibration multiplier (applied after raw estimation). */
export const CATEGORY_CALIBRATION: Record<SpanCategory, number> = {
  'user-interaction': 1.0,    // Keep as-is — this is the real work
  'orchestration':    0.70,   // Coordination overhead, lighter than user work
  'retry':            0.55,   // Context reuse means 45% is redundant cost
  'escalation':       1.00,   // Escalation is real cost — full model call
  'wrapper':          0.30,   // Lifecycle wrappers have tiny token footprint
  'infrastructure':   0.12,   // Title gen, progress msgs: minimal context
  'tool-call':        0.85,   // Tool calls are substantial but not full scale
  'hidden-inference': 0.40,   // Background work the user didn't trigger
};

// ---------------------------------------------------------------------------
// Workflow-to-category classification rules
// ---------------------------------------------------------------------------

interface WorkflowRule {
  readonly pattern: RegExp;
  readonly category: SpanCategory;
  readonly label: string;
}

const WORKFLOW_RULES: readonly WorkflowRule[] = [
  // Infrastructure — minimal-cost background work
  { pattern: /title/i,                         category: 'infrastructure',    label: 'Title Generation' },
  { pattern: /progressmessage/i,               category: 'infrastructure',    label: 'Progress Messages' },
  { pattern: /summarize/i,                     category: 'infrastructure',    label: 'Conversation Summary' },
  { pattern: /conversationhistory/i,           category: 'infrastructure',    label: 'History Summary' },

  // Tool calls — agent tool invocations
  { pattern: /panel\/editagent/i,              category: 'tool-call',         label: 'Edit Agent' },
  { pattern: /executionsubagenttool/i,         category: 'tool-call',         label: 'Subagent Tool' },
  { pattern: /subagent/i,                      category: 'tool-call',         label: 'Subagent' },
  { pattern: /tool/i,                          category: 'tool-call',         label: 'Tool Call' },

  // Wrappers — session/token lifecycle
  { pattern: /tokencount/i,                    category: 'wrapper',           label: 'Token Count' },
  { pattern: /session(?!Store)/i,              category: 'wrapper',           label: 'Session Wrapper' },
  { pattern: /wrapper/i,                       category: 'wrapper',           label: 'Wrapper' },

  // Hidden inference — background AI work
  { pattern: /hidden/i,                        category: 'hidden-inference',  label: 'Hidden Inference' },
  { pattern: /background/i,                    category: 'hidden-inference',  label: 'Background Inference' },

  // Orchestration — coordination between models/agents
  { pattern: /orchestrat/i,                    category: 'orchestration',     label: 'Orchestration' },
  { pattern: /routing/i,                       category: 'orchestration',     label: 'Model Routing' },
];

/**
 * Semantic span classifier.
 *
 * THE CRITICAL ROLE:
 *   Transforms raw observable spans into semantically meaningful categories.
 *   This is what allows BurnSight to report "2 Interactions, 9 Operations"
 *   instead of the misleading "9 Requests."
 *
 * Classification precedence (highest → lowest):
 *   1. Span.type (retry, escalation, tool-call, wrapper) — structural
 *   2. Workflow pattern matching (progressMessages → infrastructure)
 *   3. Span position (last span in chain → user-interaction by default)
 *   4. Span index (first model-call in non-infra trace → user-interaction)
 *
 * The classifier is STATELESS and PURE — same inputs always produce same outputs.
 *
 * Usage: call classify() on each enriched trace as it exits EconomicsEngine.
 */
export class TraceClassifier {
  /**
   * Classify all spans in a trace and attach InteractionSemantics.
   * Returns a new trace — does not mutate the original.
   */
  public classify(trace: InteractionTrace): InteractionTrace {
    const classifiedSpans = this.classifySpans(trace);
    const semantics = this.buildSemantics(trace, classifiedSpans);

    return {
      ...trace,
      semantics,
    };
  }

  // --------------------------------------------------------------------------
  // Span classification
  // --------------------------------------------------------------------------

  private classifySpans(trace: InteractionTrace): ClassifiedSpan[] {
    const spans = [...trace.spans] as Span[];
    const classified: ClassifiedSpan[] = [];

    // Determine which span(s) are the "primary" user-visible response.
    // For a single-model trace it's the last model-call span.
    // For escalation traces the final model in the chain is user-visible.
    const primarySpanIndex = this.findPrimarySpanIndex(spans);

    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      classified.push(
        this.classifySpan(span, i === primarySpanIndex, i, spans.length),
      );
    }

    return classified;
  }

  private classifySpan(
    span: Span,
    isPrimary: boolean,
    index: number,
    totalSpans: number,
  ): ClassifiedSpan {
    const category = this.resolveCategory(span, isPrimary, index, totalSpans);
    const label = this.resolveLabel(span, category);
    const calibration = CATEGORY_CALIBRATION[category];

    return {
      ...span,
      category,
      isUserVisible: category === 'user-interaction' || category === 'tool-call',
      isOrchestrationOverhead: category !== 'user-interaction' && category !== 'escalation',
      calibrationMultiplier: calibration,
      timelineLabel: label,
    };
  }

  private resolveCategory(
    span: Span,
    isPrimary: boolean,
    index: number,
    totalSpans: number,
  ): SpanCategory {
    // Structural type takes precedence
    if (span.type === 'retry') {
      return 'retry';
    }
    if (span.type === 'escalation') {
      return 'escalation';
    }
    if (span.type === 'tool-call') {
      return 'tool-call';
    }
    if (span.type === 'wrapper') {
      return 'wrapper';
    }

    // Workflow pattern matching
    const workflow = span.workflow ?? '';
    for (const rule of WORKFLOW_RULES) {
      if (rule.pattern.test(workflow)) {
        return rule.category;
      }
    }

    // Model-call classification
    if (isPrimary) {
      return 'user-interaction';
    }

    // Earlier model-calls in multi-span traces are orchestration (not escalation,
    // since escalation is detected by span.type)
    if (totalSpans > 1 && index < totalSpans - 1) {
      return 'orchestration';
    }

    return 'user-interaction';
  }

  private resolveLabel(span: Span, category: SpanCategory): string {
    // Use workflow-specific label if available
    const workflow = span.workflow ?? '';
    for (const rule of WORKFLOW_RULES) {
      if (rule.pattern.test(workflow)) {
        return rule.label;
      }
    }

    // Structural label fallbacks
    switch (category) {
      case 'user-interaction': {
        const model = span.model ?? 'Model';
        return `${model} — Response`;
      }
      case 'orchestration':    return `Orchestration (${span.model ?? 'router'})`;
      case 'retry':            return 'Retry Attempt';
      case 'escalation':       return `Escalated → ${span.model ?? 'unknown'}`;
      case 'wrapper':          return 'Session Wrapper';
      case 'infrastructure':   return span.workflow ?? 'Infrastructure';
      case 'tool-call':        return span.workflow ?? 'Tool Call';
      case 'hidden-inference': return 'Background Inference';
      default:                 return span.workflow ?? 'Model Call';
    }
  }

  // --------------------------------------------------------------------------
  // Semantics construction
  // --------------------------------------------------------------------------

  private buildSemantics(
    trace: InteractionTrace,
    classifiedSpans: ClassifiedSpan[],
  ): InteractionSemantics {
    const internalOperationCount = classifiedSpans.length;

    // Compute orchestration overhead ratio from costs
    const totalCost = trace.estimatedCostUsd;
    let orchestrationCost = 0;
    let retryCost = 0;
    for (const span of classifiedSpans) {
      const rawCost = span.estimatedCostUsd ?? 0;
      if (span.isOrchestrationOverhead) {
        orchestrationCost += rawCost;
      }
      if (span.category === 'retry') {
        retryCost += rawCost;
      }
    }

    const orchestrationOverheadRatio =
      totalCost > 0 ? Math.min(1, orchestrationCost / totalCost) : 0;

    const retryAmplification = 1 + (
      totalCost > 0 ? retryCost / (totalCost - retryCost || 1) : 0
    );

    // Escalation chain from modelsUsed + escalation spans
    const escalationChain = this.buildEscalationChain(trace, classifiedSpans);

    // Dominant workflow — most expensive non-infrastructure workflow
    const dominantWorkflow = this.findDominantWorkflow(trace, classifiedSpans);

    const hiddenInferenceCount = classifiedSpans.filter(
      (s) => s.category === 'hidden-inference',
    ).length;

    const infrastructureCount = classifiedSpans.filter(
      (s) => s.category === 'infrastructure',
    ).length;

    return {
      interactionCount: 1,
      internalOperationCount,
      orchestrationOverheadRatio: parseFloat(orchestrationOverheadRatio.toFixed(3)),
      retryAmplification: parseFloat(retryAmplification.toFixed(3)),
      escalationChain,
      dominantWorkflow,
      classifiedSpans,
      hiddenInferenceCount,
      infrastructureCount,
    };
  }

  private buildEscalationChain(
    trace: InteractionTrace,
    classifiedSpans: ClassifiedSpan[],
  ): string[] {
    // If we have an explicit model chain from the signal, use it
    if (trace.modelsUsed.length > 1) {
      return [...trace.modelsUsed];
    }
    // Otherwise derive from escalation spans
    const escalationSpans = classifiedSpans.filter(
      (s) => s.category === 'escalation' && s.model,
    );
    if (escalationSpans.length > 0) {
      const first = classifiedSpans[0]?.model;
      const chain: string[] = first ? [first] : [];
      for (const span of escalationSpans) {
        if (span.model && !chain.includes(span.model)) {
          chain.push(span.model);
        }
      }
      return chain;
    }
    return trace.modelsUsed.length > 0 ? [...trace.modelsUsed] : [];
  }

  private findDominantWorkflow(
    trace: InteractionTrace,
    classifiedSpans: ClassifiedSpan[],
  ): string {
    // Find the most expensive non-infrastructure workflow
    const workflowCosts: Record<string, number> = {};
    for (const span of classifiedSpans) {
      if (span.category === 'infrastructure' || span.category === 'wrapper') {
        continue;
      }
      const wf = span.workflow ?? 'unknown';
      workflowCosts[wf] = (workflowCosts[wf] ?? 0) + (span.estimatedCostUsd ?? 0);
    }

    const sorted = Object.entries(workflowCosts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      return sorted[0][0];
    }

    // Fall back to trace's workflow breakdown
    const wb = trace.workflowBreakdown;
    if (wb.length > 0) {
      const sorted2 = [...wb].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
      return sorted2[0].workflow;
    }

    return trace.interactionType;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Find the index of the primary user-visible span.
   * For escalation chains the last model-call is the final response.
   * Otherwise the last span is assumed to be the primary.
   */
  private findPrimarySpanIndex(spans: Span[]): number {
    if (spans.length === 0) {
      return -1;
    }

    // Walk backwards: find the last non-infrastructure, non-retry model-call
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      if (span.type === 'retry' || span.type === 'wrapper') {
        continue;
      }
      const workflow = span.workflow ?? '';
      const isInfra = WORKFLOW_RULES.some(
        (r) => r.category === 'infrastructure' && r.pattern.test(workflow),
      );
      if (!isInfra) {
        return i;
      }
    }

    // Default to last span
    return spans.length - 1;
  }
}
