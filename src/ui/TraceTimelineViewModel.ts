import { InteractionTrace, ClassifiedSpan, SpanCategory } from '../domain/InteractionTrace';

// ---------------------------------------------------------------------------
// Timeline event types
// ---------------------------------------------------------------------------

export type TimelineEventType =
  | 'interaction-started'
  | 'model-call'
  | 'tool-call'
  | 'retry'
  | 'escalation'
  | 'infrastructure'
  | 'orchestration'
  | 'hidden-inference'
  | 'final-response';

export interface TimelineEvent {
  readonly id: string;
  readonly timestamp: number;
  /** HH:MM formatted label */
  readonly timeLabel: string;
  /** Seconds elapsed since trace started */
  readonly elapsedSec: number;
  readonly type: TimelineEventType;
  /** Short human-readable description */
  readonly label: string;
  /** Longer explanation for tooltips */
  readonly detail: string;
  readonly model?: string;
  readonly workflow?: string;
  readonly latencyMs?: number;
  readonly estimatedCostUsd?: number;
  /** Semantic category from TraceClassifier */
  readonly category: SpanCategory | 'start';
  /** True if this event should be prominently shown */
  readonly isHighlighted: boolean;
}

/**
 * Chronological timeline for one InteractionTrace.
 *
 * PRODUCT PURPOSE:
 *   Answers the question: "what happened inside this interaction?"
 *   A user seeing high cost or long latency can trace EXACTLY which internal
 *   operations were responsible.
 *
 * Example timeline for "write quicksort in python":
 *   12:41  Interaction Started    (user-visible)
 *   12:41  Title Generation       (infrastructure — tiny)
 *   12:41  Progress Messages      (infrastructure — tiny)
 *   12:42  Escalated → gpt-codex  (escalation — model switch)
 *   12:42  Edit Agent             (tool-call — main work)
 *   12:43  Final Response         (user-interaction)
 */
export interface TraceTimeline {
  readonly traceId: string;
  readonly interactionType: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly durationMs: number;
  readonly events: readonly TimelineEvent[];
  /** Number of user-visible events (excludes infrastructure/hidden) */
  readonly visibleEventCount: number;
  /** Total cost across all events */
  readonly estimatedCostUsd: number;
  readonly dominantWorkflow: string;
  /** Escalation label — e.g. 'gpt-4o-mini → gpt-5.3-codex' */
  readonly escalationLabel?: string;
}

/**
 * Session-level timeline — ordered list of individual trace timelines.
 */
export interface SessionTimeline {
  readonly sessionId: string;
  readonly traces: readonly TraceTimeline[];
  readonly totalInteractions: number;
  readonly totalInternalOperations: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Derives a chronological TraceTimeline from a completed InteractionTrace.
 *
 * Uses InteractionSemantics (classifiedSpans) when available.
 * Falls back to raw spans with basic type-based labeling when semantics
 * are absent (e.g. legacy traces loaded from disk).
 */
export function buildTraceTimeline(trace: InteractionTrace): TraceTimeline {
  const events: TimelineEvent[] = [];

  // 1. Interaction-started event
  events.push({
    id: `${trace.traceId}-start`,
    timestamp: trace.startedAt,
    timeLabel: formatTime(trace.startedAt),
    elapsedSec: 0,
    type: 'interaction-started',
    label: 'Interaction Started',
    detail: `${trace.interactionType} interaction began`,
    category: 'start',
    isHighlighted: true,
  });

  // 2. One event per span — prefer classified spans if available
  const spans = trace.semantics?.classifiedSpans ?? [];
  const rawSpans = trace.spans;

  if (spans.length > 0) {
    for (const span of spans) {
      const elapsed = (span.startedAt - trace.startedAt) / 1000;
      events.push({
        id: `${trace.traceId}-${span.spanId}`,
        timestamp: span.startedAt,
        timeLabel: formatTime(span.startedAt),
        elapsedSec: parseFloat(elapsed.toFixed(1)),
        type: spanCategoryToEventType(span.category),
        label: span.timelineLabel,
        detail: buildSpanDetail(span),
        model: span.model,
        workflow: span.workflow,
        latencyMs: span.latencyMs,
        estimatedCostUsd: span.estimatedCostUsd,
        category: span.category,
        isHighlighted: span.isUserVisible,
      });
    }
  } else {
    // Fallback: no classified spans, use raw spans
    for (const span of rawSpans) {
      const elapsed = (span.startedAt - trace.startedAt) / 1000;
      events.push({
        id: `${trace.traceId}-${span.spanId}`,
        timestamp: span.startedAt,
        timeLabel: formatTime(span.startedAt),
        elapsedSec: parseFloat(elapsed.toFixed(1)),
        type: spanTypeToEventType(span.type),
        label: labelForRawSpan(span),
        detail: `${span.type}${span.model ? ` — ${span.model}` : ''}`,
        model: span.model,
        workflow: span.workflow,
        latencyMs: span.latencyMs,
        estimatedCostUsd: span.estimatedCostUsd,
        category: 'user-interaction', // conservative default
        isHighlighted: span.type === 'model-call',
      });
    }
  }

  // 3. Final response marker (if trace completed)
  if (trace.completedAt && events[events.length - 1]?.type !== 'final-response') {
    const lastHighlighted = [...events].reverse().find((e) => e.isHighlighted);
    if (lastHighlighted && lastHighlighted.type !== 'interaction-started') {
      // Replace last highlighted event's type with final-response
      const idx = events.lastIndexOf(lastHighlighted as TimelineEvent);
      if (idx >= 0) {
        events[idx] = {
          ...events[idx],
          type: 'final-response',
          label: events[idx].label.replace(/— Response$/, '— Final Response'),
          isHighlighted: true,
        };
      }
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp - b.timestamp);

  const durationMs = trace.completedAt
    ? trace.completedAt - trace.startedAt
    : 0;

  const semantics = trace.semantics;
  const escalationLabel =
    semantics && semantics.escalationChain.length > 1
      ? semantics.escalationChain.join(' → ')
      : undefined;

  return {
    traceId: trace.traceId,
    interactionType: trace.interactionType,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    durationMs,
    events,
    visibleEventCount: events.filter((e) => e.isHighlighted).length,
    estimatedCostUsd: trace.estimatedCostUsd,
    dominantWorkflow: semantics?.dominantWorkflow ?? trace.workflowBreakdown[0]?.workflow ?? trace.interactionType,
    escalationLabel,
  };
}

/**
 * Build a session-level timeline from all traces, newest first.
 */
export function buildSessionTimeline(
  sessionId: string,
  interactions: readonly InteractionTrace[],
): SessionTimeline {
  const sortedTraces = [...interactions].sort((a, b) => b.startedAt - a.startedAt);
  const traces = sortedTraces.map(buildTraceTimeline);

  const totalInternalOperations = interactions.reduce(
    (sum, t) => sum + (t.semantics?.internalOperationCount ?? t.spans.length),
    0,
  );

  return {
    sessionId,
    traces,
    totalInteractions: interactions.length,
    totalInternalOperations,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function spanCategoryToEventType(category: SpanCategory): TimelineEventType {
  switch (category) {
    case 'user-interaction': return 'model-call';
    case 'orchestration':    return 'orchestration';
    case 'retry':            return 'retry';
    case 'escalation':       return 'escalation';
    case 'wrapper':          return 'infrastructure';
    case 'infrastructure':   return 'infrastructure';
    case 'tool-call':        return 'tool-call';
    case 'hidden-inference': return 'hidden-inference';
    default:                 return 'model-call';
  }
}

function spanTypeToEventType(
  type: 'model-call' | 'tool-call' | 'retry' | 'wrapper' | 'escalation',
): TimelineEventType {
  switch (type) {
    case 'model-call':  return 'model-call';
    case 'tool-call':   return 'tool-call';
    case 'retry':       return 'retry';
    case 'wrapper':     return 'infrastructure';
    case 'escalation':  return 'escalation';
    default:            return 'model-call';
  }
}

function buildSpanDetail(span: ClassifiedSpan): string {
  const parts: string[] = [];
  if (span.model) {
    parts.push(`Model: ${span.model}`);
  }
  if (span.latencyMs) {
    parts.push(`${span.latencyMs}ms`);
  }
  if (span.estimatedCostUsd && span.estimatedCostUsd > 0) {
    parts.push(`~$${span.estimatedCostUsd.toFixed(4)}`);
  }
  if (span.workflow) {
    parts.push(`Workflow: ${span.workflow}`);
  }
  return parts.join(' · ') || span.category;
}

function labelForRawSpan(span: { type: string; model?: string; workflow?: string }): string {
  if (span.workflow) {return span.workflow;}
  if (span.model) {return `${span.type} — ${span.model}`;}
  return span.type;
}
