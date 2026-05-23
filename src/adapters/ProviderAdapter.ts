import { RawSignal } from '../domain/RawSignal';

/**
 * Contract for all AI provider adapters.
 *
 * Each adapter is responsible for translating provider-specific runtime signals
 * (Copilot log events, IPC messages, API callbacks) into canonical RawSignals.
 *
 * Adapters MUST NOT:
 *   - Generate metrics directly
 *   - Compute token estimates
 *   - Persist data
 *   - Depend on the CorrelationEngine or SessionStore
 *
 * Adapters MUST:
 *   - Emit only normalized RawSignal objects
 *   - Handle their own deduplication
 *   - Be safe to start/stop repeatedly
 *   - Release all resources on stop()
 *
 * Implemented:
 *   - GitHubCopilotAdapter
 *
 * Future:
 *   - ClaudeCodeAdapter
 *   - CursorAdapter
 *   - CodexAdapter
 *   - GeminiAdapter
 *   - OllamaAdapter
 */
export interface ProviderAdapter {
  /** Unique provider identifier — e.g. 'github-copilot' */
  readonly providerId: string;

  /** Begin observing provider runtime signals. Idempotent. */
  start(): Promise<void>;

  /** Stop observing and release all resources. Idempotent. */
  stop(): Promise<void>;

  /** Register a callback to receive normalized RawSignals. */
  onSignal(callback: (signal: RawSignal) => void): { dispose: () => void };
}
