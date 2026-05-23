/**
 * Regular expression patterns for parsing GitHub Copilot Chat output channel logs.
 *
 * All patterns were derived from observed real log output.  The field names below
 * correspond to properties on CopilotLogEvent.
 *
 * CONFIDENCE: REAL — these patterns match literal text from the Copilot log stream.
 *             The data they extract is direct, uninterpreted observation.
 */

/**
 * Matches the "request done" lifecycle marker that signals a completed request.
 * Observed format: "request done" (case-insensitive).
 */
export const REQUEST_DONE = /request\s+done/i;

/**
 * Extracts the Copilot request ID.
 * Observed formats:
 *   "requestId: xxxx"
 *   "requestId=xxxx"
 */
export const REQUEST_ID = /requestId[=:\s]+([a-z0-9_-]+)/i;

/**
 * Extracts the model name from a log line.
 * Observed formats:
 *   "model: gpt-4o-mini-2024-07-18"
 *   "model":"gpt-5.3-codex"
 *   "model=gpt-4o"
 *
 * The pattern intentionally stops at whitespace or quote/comma to avoid
 * over-capturing JSON structure.
 */
export const MODEL_NAME = /\bmodel[=:\s"]+([a-zA-Z0-9._-]+)/i;

/**
 * Extracts request latency in milliseconds.
 * Observed formats:
 *   "1746ms"
 *   "took 2276ms"
 *   "duration: 6724ms"
 *
 * Requires 3–6 digits to avoid matching short port numbers or line counts.
 */
export const LATENCY_MS = /\b(\d{3,6})\s*ms\b/;

/**
 * Extracts the finish reason from a completed response.
 * Observed formats:
 *   "finishReason: stop"
 *   "finish_reason: length"
 *   "finishReason=cancelled"
 */
export const FINISH_REASON = /finish[_\s]?reason[=:\s"]+([a-zA-Z_]+)/i;

/**
 * Extracts provider metadata.
 * Observed formats:
 *   "provider: openai"
 *   "provider=anthropic"
 *   "providerName: google"
 */
export const PROVIDER = /provider(?:Name)?[=:\s"]+([a-zA-Z0-9._-]+)/i;

/**
 * Canonical runtime event format observed in Copilot logs.
 * Example:
 *   ccreq:60c6ab57.copilotmd | success | gpt-5.3-codex | 9068ms | [panel/editAgent]
 */
export const CANONICAL_EVENT =
  /ccreq:([a-z0-9]+)\.copilotmd\s*\|\s*(success|failed|failure|error|cancelled)\s*\|\s*([a-zA-Z0-9._-]+)\s*\|\s*(\d{2,6})ms\s*\|\s*\[([^\]]+)\]/i;

/**
 * Extracts source type from bracket tags when available.
 * Example:
 *   [panel/editAgent]
 */
export const SOURCE_TYPE_BRACKET = /\[([^\]]+)\]/;

/**
 * Extracts session artifact identifiers.
 * Observed format: "ccreq:xxxx.copilotmd"
 */
export const SESSION_ARTIFACT = /ccreq:([a-z0-9.]+)/i;

/**
 * Returns true if a log line is worth further parsing.
 * Used to skip high-volume lines that carry no telemetry signal.
 */
export function isRelevantLine(line: string): boolean {
  return (
    CANONICAL_EVENT.test(line) ||
    REQUEST_DONE.test(line) ||
    LATENCY_MS.test(line) ||
    MODEL_NAME.test(line) ||
    REQUEST_ID.test(line) ||
    FINISH_REASON.test(line) ||
    SESSION_ARTIFACT.test(line) ||
    PROVIDER.test(line)
  );
}
