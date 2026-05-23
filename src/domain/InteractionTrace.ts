import { ConfidenceLevel } from './ConfidenceLevel';

/**
 * Interaction type — the semantic category of the user-visible AI interaction.
 * Correlates multiple internal spans into one user-facing operation.
 */
export type InteractionType =
  | 'chat'
  | 'inline-completion'
  | 'edit-agent'
  | 'tool-assisted';

/**
 * Span type — the role of one observable model/tool invocation within a trace.
 */
export type SpanType =
  | 'model-call'
  | 'tool-call'
  | 'retry'
  | 'wrapper'
  | 'escalation';

// ---------------------------------------------------------------------------
// Semantic classification layer — applied by TraceClassifier after correlation.
// ---------------------------------------------------------------------------

/**
 * Semantic category for a span — answers "what kind of work was this?".
 *
 * user-interaction  The primary AI work the user explicitly requested.
 * orchestration     Internal routing / coordination not user-triggered.
 * retry             Repeated attempt at the same work (context reuse possible).
 * escalation        Routing to a more capable model in a chain.
 * wrapper           Lifecycle wrappers (session init, token counting, etc.).
 * infrastructure    Housekeeping: title generation, progress messages, summaries.
 * tool-call         Agent tool / subagent invocations within edit-agent flows.
 * hidden-inference  Background inference the user neither saw nor triggered.
 */
export type SpanCategory =
  | 'user-interaction'
  | 'orchestration'
  | 'retry'
  | 'escalation'
  | 'wrapper'
  | 'infrastructure'
  | 'tool-call'
  | 'hidden-inference';

/**
 * A Span with semantic classification applied by TraceClassifier.
 * Extends Span — does not mutate the base span fields.
 */
export interface ClassifiedSpan extends Span {
  /** Semantic category of this span */
  readonly category: SpanCategory;
  /** True if this span represents work the user would recognise */
  readonly isUserVisible: boolean;
  /** True if this span is internal overhead, not the primary response */
  readonly isOrchestrationOverhead: boolean;
  /** Cost calibration multiplier applied by EconomicsCalibrator (0.0–1.0+) */
  readonly calibrationMultiplier: number;
  /** Short human-readable label for timeline display */
  readonly timelineLabel: string;
}

/**
 * Semantic interpretation of an InteractionTrace.
 * Computed by TraceClassifier; attached as trace.semantics.
 *
 * Enables the product to answer:
 *  "why did this interaction cost so much?"
 *  "how much was orchestration overhead?"
 *  "what models were involved in escalation?"
 */
export interface InteractionSemantics {
  /** Always 1 — this trace represents exactly one user interaction */
  readonly interactionCount: 1;
  /** Total number of internal spans (includes infrastructure, retries, etc.) */
  readonly internalOperationCount: number;
  /**
   * Fraction of estimated cost attributable to orchestration overhead (0.0–1.0).
   * e.g. 0.35 means 35% of cost was infrastructure / wrappers / hidden inference.
   */
  readonly orchestrationOverheadRatio: number;
  /**
   * Cost amplification from retries (1.0 = no retry overhead).
   * e.g. 1.20 means retries added ~20% to the interaction cost.
   */
  readonly retryAmplification: number;
  /** Models in escalation order — e.g. ['gpt-4o-mini', 'gpt-5.3-codex'] */
  readonly escalationChain: readonly string[];
  /** Most semantically significant workflow in this interaction */
  readonly dominantWorkflow: string;
  /** Per-span semantic classifications */
  readonly classifiedSpans: readonly ClassifiedSpan[];
  /** Count of spans classified as hidden-inference */
  readonly hiddenInferenceCount: number;
  /** Count of spans classified as infrastructure */
  readonly infrastructureCount: number;
}

/**
 * One observable unit of work within an InteractionTrace.
 * Maps to a single model invocation, tool call, retry hop, or escalation.
 *
 * Economics fields are populated by EconomicsEngine after correlation.
 */
export interface Span {
  readonly spanId: string;
  readonly type: SpanType;
  readonly model?: string;
  readonly workflow?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly latencyMs?: number;
  /** Estimated — populated by EconomicsEngine */
  readonly estimatedInputTokens?: number;
  /** Estimated — populated by EconomicsEngine */
  readonly estimatedOutputTokens?: number;
  /** Estimated — populated by EconomicsEngine */
  readonly estimatedCostUsd?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Per-workflow economics summary within a trace.
 */
export interface WorkflowBreakdown {
  readonly workflow: string;
  readonly spanCount: number;
  /** Estimated — populated by EconomicsEngine */
  readonly estimatedCostUsd: number;
  /** Estimated — input + output tokens combined */
  readonly estimatedTokens: number;
}

/**
 * Canonical unit of observable AI work.
 *
 * ONE InteractionTrace = ONE logical user interaction.
 *
 * Regardless of how many internal model calls, retries, orchestration hops,
 * wrapper calls, or tool invocations occurred internally, the CorrelationEngine
 * merges them all into a single trace.
 *
 * Example:
 *   User: "write quicksort in python"
 *   Internal signals: title generation + progress messages + edit agent + retry
 *   Result: ONE InteractionTrace with 4 spans
 *
 * Privacy rules:
 *   - Raw prompts and responses are NEVER stored.
 *   - Only promptHash, promptLength, and responseLength are captured.
 */
export interface InteractionTrace {
  readonly traceId: string;
  readonly sessionId: string;
  readonly interactionType: InteractionType;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly spans: readonly Span[];
  readonly modelsUsed: readonly string[];
  /** Estimated — filled by EconomicsEngine */
  readonly estimatedInputTokens: number;
  /** Estimated — filled by EconomicsEngine */
  readonly estimatedOutputTokens: number;
  /** Estimated — filled by EconomicsEngine */
  readonly estimatedCostUsd: number;
  readonly retryCount: number;
  readonly escalationCount: number;
  readonly workflowBreakdown: readonly WorkflowBreakdown[];
  readonly confidence: ConfidenceLevel;
  /** SHA-256 hash of prompt — privacy-safe identifier */
  readonly promptHash?: string;
  /** Character count of the prompt — not the prompt itself */
  readonly promptLength?: number;
  /** Character count of the response — not the response itself */
  readonly responseLength?: number;
  /**
   * Semantic interpretation computed by TraceClassifier.
   * Optional: present when the classifier has been applied; absent on
   * raw/legacy traces loaded from disk before classification was introduced.
   */
  readonly semantics?: InteractionSemantics;
}
