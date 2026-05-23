import {
  InteractionTrace,
  ClassifiedSpan,
  SpanCategory,
  WorkflowBreakdown,
} from '../domain/InteractionTrace';
import { ConfidenceLevel } from '../domain/ConfidenceLevel';
import { CATEGORY_CALIBRATION } from '../classification/TraceClassifier';

/**
 * Economics calibration output for a single InteractionTrace.
 */
export interface CalibratedEconomics {
  /** Token estimate before calibration */
  readonly rawInputTokens: number;
  readonly rawOutputTokens: number;
  /** Cost estimate before calibration */
  readonly rawCostUsd: number;
  /** Token estimate after per-category calibration */
  readonly calibratedInputTokens: number;
  readonly calibratedOutputTokens: number;
  /** Cost estimate after calibration */
  readonly calibratedCostUsd: number;
  /** Portion of calibrated cost attributable to orchestration overhead */
  readonly orchestrationOverheadCostUsd: number;
  /** Additional cost introduced by retries (above the base interaction cost) */
  readonly retryAmplificationCostUsd: number;
  /** Estimated cost of hidden-inference spans */
  readonly hiddenInferenceCostUsd: number;
  /** Reduction factor: calibratedCostUsd / rawCostUsd (< 1 means deflation) */
  readonly calibrationFactor: number;
  readonly confidence: ConfidenceLevel;
}

// ---------------------------------------------------------------------------
// Workflow-level deflation caps.
// Even after span-level calibration, some workflows inflate the raw numbers
// more than others because the log line itself contains extra debug cruft.
// These caps prevent runaway estimates.
// ---------------------------------------------------------------------------

interface WorkflowCap {
  pattern: RegExp;
  /** Hard cap on estimated cost per interaction, in USD */
  maxCostUsd: number;
  /** Hard cap on estimated input tokens per interaction */
  maxInputTokens: number;
}

const WORKFLOW_CAPS: readonly WorkflowCap[] = [
  { pattern: /title/i,              maxCostUsd: 0.0005, maxInputTokens: 200   },
  { pattern: /progressmessage/i,    maxCostUsd: 0.001,  maxInputTokens: 300   },
  { pattern: /summarize/i,          maxCostUsd: 0.004,  maxInputTokens: 2000  },
  { pattern: /inline|completion/i,  maxCostUsd: 0.003,  maxInputTokens: 1500  },
];

/**
 * EconomicsCalibrator — makes BurnSight's cost estimates BELIEVABLE.
 *
 * THE CORE PROBLEM BEING SOLVED:
 *   Raw token heuristics treat every span equally.
 *   A "title generation" span gets the same per-token cost as a full code edit.
 *   This causes significant inflation when 9 internal operations are all
 *   estimated at full scale.
 *
 * THE SOLUTION:
 *   Apply per-category calibration multipliers (from TraceClassifier) to
 *   deflate infrastructure/wrapper/retry spans back to realistic levels.
 *   The calibration factors come from empirical observation of Copilot's
 *   actual request patterns.
 *
 * IMPORTANT DESIGN PRINCIPLE:
 *   We NEVER fake precision.  We prefer stable believable estimates over
 *   false exactness.  The confidence is always HEURISTIC.
 *
 * Pipeline position:
 *   EconomicsEngine.enrichTrace() → TraceClassifier.classify()
 *                                  → EconomicsCalibrator.calibrate()
 *                                  → SessionStore.appendTrace()
 */
export class EconomicsCalibrator {
  /**
   * Apply semantic calibration to an already-classified trace.
   * Requires trace.semantics to be populated (by TraceClassifier).
   * If semantics are absent, returns the trace unmodified.
   */
  public calibrate(trace: InteractionTrace): InteractionTrace {
    const semantics = trace.semantics;
    if (!semantics || semantics.classifiedSpans.length === 0) {
      return trace;
    }

    const calibrated = this.computeCalibratedEconomics(trace);
    const calibratedSpans = this.calibrateSpans(semantics.classifiedSpans);
    const calibratedWorkflows = this.calibrateWorkflowBreakdown(
      trace.workflowBreakdown as WorkflowBreakdown[],
      calibratedSpans,
      calibrated.calibratedCostUsd,
    );

    // Propagate calibrated totals back to semantics
    const updatedSemantics = {
      ...semantics,
      classifiedSpans: calibratedSpans,
    };

    return {
      ...trace,
      spans: calibratedSpans,
      workflowBreakdown: calibratedWorkflows,
      estimatedInputTokens: calibrated.calibratedInputTokens,
      estimatedOutputTokens: calibrated.calibratedOutputTokens,
      estimatedCostUsd: calibrated.calibratedCostUsd,
      confidence: ConfidenceLevel.HEURISTIC,
      semantics: updatedSemantics,
    };
  }

  /**
   * Compute calibrated economics without modifying the trace.
   * Useful for analytics and reporting.
   */
  public computeCalibratedEconomics(trace: InteractionTrace): CalibratedEconomics {
    const rawInputTokens = trace.estimatedInputTokens;
    const rawOutputTokens = trace.estimatedOutputTokens;
    const rawCostUsd = trace.estimatedCostUsd;

    const semantics = trace.semantics;
    if (!semantics || semantics.classifiedSpans.length === 0) {
      return {
        rawInputTokens,
        rawOutputTokens,
        rawCostUsd,
        calibratedInputTokens: rawInputTokens,
        calibratedOutputTokens: rawOutputTokens,
        calibratedCostUsd: rawCostUsd,
        orchestrationOverheadCostUsd: 0,
        retryAmplificationCostUsd: 0,
        hiddenInferenceCostUsd: 0,
        calibrationFactor: 1.0,
        confidence: ConfidenceLevel.HEURISTIC,
      };
    }

    let calibratedInput = 0;
    let calibratedOutput = 0;
    let calibratedCost = 0;
    let orchestrationCost = 0;
    let retryCost = 0;
    let hiddenCost = 0;

    for (const span of semantics.classifiedSpans) {
      const spanInput = span.estimatedInputTokens ?? 0;
      const spanOutput = span.estimatedOutputTokens ?? 0;
      const spanCost = span.estimatedCostUsd ?? 0;
      const m = this.getEffectiveMultiplier(span.category, span.workflow);

      calibratedInput  += Math.round(spanInput * m);
      calibratedOutput += Math.round(spanOutput * m);
      calibratedCost   += spanCost * m;

      if (span.category === 'retry') {
        retryCost += spanCost * m;
      }
      if (span.category === 'hidden-inference') {
        hiddenCost += spanCost * m;
      }
      if (span.isOrchestrationOverhead) {
        orchestrationCost += spanCost * m;
      }
    }

    // Apply workflow-level caps as a final guardrail
    const wfCap = this.resolveWorkflowCap(
      trace.workflowBreakdown[0]?.workflow ?? trace.interactionType,
    );
    if (wfCap) {
      calibratedInput = Math.min(calibratedInput, wfCap.maxInputTokens);
      calibratedOutput = Math.min(calibratedOutput, Math.round(wfCap.maxInputTokens * 0.6));
      calibratedCost = Math.min(calibratedCost, wfCap.maxCostUsd);
      orchestrationCost = Math.min(orchestrationCost, calibratedCost * 0.5);
      retryCost = Math.min(retryCost, calibratedCost * 0.3);
      hiddenCost = Math.min(hiddenCost, calibratedCost * 0.2);
    }

    const calibrationFactor = rawCostUsd > 0
      ? parseFloat((calibratedCost / rawCostUsd).toFixed(3))
      : 1.0;

    return {
      rawInputTokens,
      rawOutputTokens,
      rawCostUsd,
      calibratedInputTokens: Math.max(1, calibratedInput),
      calibratedOutputTokens: Math.max(1, calibratedOutput),
      calibratedCostUsd: Math.max(0, calibratedCost),
      orchestrationOverheadCostUsd: Math.max(0, orchestrationCost),
      retryAmplificationCostUsd: Math.max(0, retryCost),
      hiddenInferenceCostUsd: Math.max(0, hiddenCost),
      calibrationFactor,
      confidence: ConfidenceLevel.HEURISTIC,
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private calibrateSpans(spans: readonly ClassifiedSpan[]): ClassifiedSpan[] {
    return spans.map((span) => {
      const m = this.getEffectiveMultiplier(span.category, span.workflow);
      return {
        ...span,
        estimatedInputTokens: Math.max(1, Math.round((span.estimatedInputTokens ?? 0) * m)),
        estimatedOutputTokens: Math.max(1, Math.round((span.estimatedOutputTokens ?? 0) * m)),
        estimatedCostUsd: (span.estimatedCostUsd ?? 0) * m,
        calibrationMultiplier: m,
      };
    });
  }

  private calibrateWorkflowBreakdown(
    breakdown: WorkflowBreakdown[],
    calibratedSpans: ClassifiedSpan[],
    totalCalibratedCost: number,
  ): WorkflowBreakdown[] {
    return breakdown.map((wb) => {
      const relevantSpans = calibratedSpans.filter((s) => s.workflow === wb.workflow);
      if (relevantSpans.length === 0) {
        return { ...wb, estimatedCostUsd: totalCalibratedCost, estimatedTokens: 0 };
      }
      return {
        ...wb,
        estimatedCostUsd: relevantSpans.reduce(
          (sum, s) => sum + (s.estimatedCostUsd ?? 0),
          0,
        ),
        estimatedTokens: relevantSpans.reduce(
          (sum, s) =>
            sum + (s.estimatedInputTokens ?? 0) + (s.estimatedOutputTokens ?? 0),
          0,
        ),
      };
    });
  }

  /**
   * Returns the effective calibration multiplier for a span.
   * Checks workflow-specific overrides before falling back to category default.
   */
  private getEffectiveMultiplier(category: SpanCategory, workflow?: string): number {
    if (workflow) {
      // Infrastructure override — hard-coded very low multipliers for known patterns
      if (/title/i.test(workflow)) {return 0.08;}
      if (/progressmessage/i.test(workflow)) {return 0.10;}
      if (/summarize|conversationhistory/i.test(workflow)) {return 0.25;}
    }
    return CATEGORY_CALIBRATION[category];
  }

  private resolveWorkflowCap(workflow: string): WorkflowCap | undefined {
    for (const cap of WORKFLOW_CAPS) {
      if (cap.pattern.test(workflow)) {
        return cap;
      }
    }
    return undefined;
  }
}
