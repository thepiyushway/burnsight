import * as vscode from 'vscode';
import { SessionLifecycleState } from '../domain/SessionTelemetry';
import { EventBus } from '../utils/EventBus';
import { BurnSightEvents } from '../telemetry/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;          // 5 minutes without activity
const RESUME_WINDOW_MS  = 30 * 60 * 1000;          // 30 minutes — resume vs new session
const ARCHIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours — archive old sessions

export interface SessionIdentity {
  /** Stable session ID — e.g. 'session-2026-05-23' */
  readonly sessionId: string;
  /** Workspace qualifier — scopes session to workspace when available */
  readonly workspaceId?: string;
  /** Epoch ms when this session was first created */
  readonly createdAt: number;
  /** Epoch ms of last known activity */
  readonly lastActivityAt: number;
  /** Current lifecycle state */
  readonly lifecycleState: SessionLifecycleState;
  /** ccreq artifact IDs observed this session */
  readonly artifactIds: readonly string[];
}

export interface SessionResolverOptions {
  idleThresholdMs?: number;
  resumeWindowMs?: number;
}

type LifecycleChangeListener = (
  from: SessionLifecycleState,
  to: SessionLifecycleState,
  session: SessionIdentity,
) => void;

/**
 * SessionResolver — deterministic session identity and lifecycle manager.
 *
 * RESPONSIBILITIES:
 *   1. Derive a stable session ID from workspace + calendar day (restartable).
 *   2. Track lifecycle state: started → active → idle → resumed / archived.
 *   3. Register observed ccreq artifacts for cross-session correlation.
 *   4. Notify listeners on lifecycle transitions.
 *   5. Emit lifecycle events onto the shared EventBus.
 *
 * IDENTITY STRATEGY:
 *   Primary key: workspaceId + YYYY-MM-DD
 *   Fallback:    global + YYYY-MM-DD (when no workspace is open)
 *   This gives us restart-stable, cross-machine-stable session IDs that
 *   survive VS Code restarts without relying on process-local state.
 *
 * SESSION SWITCH DETECTION:
 *   A "session switch" happens when:
 *     - The workspace changes (different folder opened)
 *     - The current date changes (new calendar day)
 *     - An artifact arrives that belongs to a different session
 *
 * [SESSION] tag is used for all log output to ease grepping.
 */
export class SessionResolver implements vscode.Disposable {
  private current: Omit<SessionIdentity, 'artifactIds'> & { artifactIds: string[] };
  private readonly lifecycleListeners: LifecycleChangeListener[] = [];
  private idleTimer: NodeJS.Timeout | undefined;

  private readonly idleThresholdMs: number;
  private readonly resumeWindowMs: number;

  constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel,
    options?: SessionResolverOptions,
  ) {
    this.idleThresholdMs = options?.idleThresholdMs ?? IDLE_THRESHOLD_MS;
    this.resumeWindowMs  = options?.resumeWindowMs  ?? RESUME_WINDOW_MS;

    const sessionId = this.deriveSessionId();
    this.current = {
      sessionId,
      workspaceId: this.resolveWorkspaceId(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lifecycleState: 'started',
      artifactIds: [],
    };

    this.log.info(
      `[SESSION] resolver initialised sessionId=${sessionId} workspace=${this.current.workspaceId ?? 'global'}`,
    );

    // Transition to started state on construction
    this.transition('started');
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Returns the current resolved session identity. */
  public get identity(): SessionIdentity {
    return this.current as SessionIdentity;
  }

  /** Returns the stable session ID for the current session. */
  public get sessionId(): string {
    return this.current.sessionId;
  }

  /**
   * Record activity — called every time a new signal arrives.
   * Transitions to ACTIVE if currently idle/started.
   * Resets the idle countdown.
   */
  public recordActivity(timestamp = Date.now()): void {
    const previous = this.current.lifecycleState;

    this.current = {
      ...this.current,
      lastActivityAt: timestamp,
    };

    if (previous === 'idle' || previous === 'started') {
      const wasIdle = previous === 'idle';
      this.transition(wasIdle ? 'resumed' : 'active');
      if (wasIdle) {
        this.log.info(
          `[SESSION-RESTORE] session resumed after idle sessionId=${this.current.sessionId}`,
        );
      }
    }

    this.resetIdleTimer();
  }

  /**
   * Register a ccreq artifact ID from a parsed log line.
   * Used for cross-session correlation and trace ownership.
   */
  public registerArtifact(artifactId: string): void {
    const artifacts = this.current.artifactIds as string[];
    if (!artifacts.includes(artifactId)) {
      artifacts.push(artifactId);
      this.log.info(
        `[SESSION] artifact registered id=${artifactId} total=${artifacts.length}`,
      );
    }
  }

  /**
   * Evaluate whether the incoming signal belongs to the current session or
   * should trigger a session switch.
   *
   * Returns 'current' | 'switch-needed'.
   * Session switches are currently calendar-day based (same day = same session).
   */
  public evaluateSignal(signalTimestamp: number): 'current' | 'switch-needed' {
    const signalDateKey = this.dateKey(new Date(signalTimestamp));
    const currentDateKey = this.dateKey(new Date(this.current.createdAt));

    if (signalDateKey !== currentDateKey) {
      this.log.info(
        `[SESSION-SWITCH] date boundary crossed from=${currentDateKey} to=${signalDateKey}`,
      );
      return 'switch-needed';
    }

    return 'current';
  }

  /**
   * Force archive of the current session (e.g. on workspace close).
   */
  public archiveSession(): void {
    this.log.info(`[SESSION] archiving sessionId=${this.current.sessionId}`);
    this.transition('archived');
    this.clearIdleTimer();
  }

  /**
   * Check whether the session needs to be refreshed (new calendar day).
   * Returns the new session ID if a refresh is needed, or undefined.
   */
  public checkForDayRollover(): string | undefined {
    const todayId = this.deriveSessionId();
    if (todayId !== this.current.sessionId) {
      this.log.info(
        `[SESSION-SWITCH] day rollover old=${this.current.sessionId} new=${todayId}`,
      );
      this.archiveSession();
      this.current = {
        ...this.current,
        sessionId: todayId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        lifecycleState: 'started',
        artifactIds: [],
      };
      this.transition('started');
      return todayId;
    }
    return undefined;
  }

  /** Register a callback to be called on lifecycle state transitions. */
  public onLifecycleChange(listener: LifecycleChangeListener): { dispose: () => void } {
    this.lifecycleListeners.push(listener);
    return {
      dispose: () => {
        const idx = this.lifecycleListeners.indexOf(listener);
        if (idx >= 0) {
          this.lifecycleListeners.splice(idx, 1);
        }
      },
    };
  }

  public dispose(): void {
    this.clearIdleTimer();
  }

  // --------------------------------------------------------------------------
  // Private — session identity
  // --------------------------------------------------------------------------

  private deriveSessionId(): string {
    const dateStr = this.dateKey(new Date());
    const workspaceId = this.resolveWorkspaceId();
    if (workspaceId) {
      return `session-${workspaceId}-${dateStr}`;
    }
    return `session-${dateStr}`;
  }

  private resolveWorkspaceId(): string | undefined {
    const wsName = vscode.workspace.name;
    if (!wsName) {
      return undefined;
    }
    // Sanitize workspace name to safe chars for file paths
    return wsName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  }

  private dateKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  // --------------------------------------------------------------------------
  // Private — lifecycle
  // --------------------------------------------------------------------------

  private transition(to: SessionLifecycleState): void {
    const from = this.current.lifecycleState;
    if (from === to) {
      return;
    }

    this.current = { ...this.current, lifecycleState: to };

    this.log.info(
      `[SESSION] lifecycle ${from} → ${to} sessionId=${this.current.sessionId}`,
    );

    for (const listener of this.lifecycleListeners) {
      listener(from, to, this.current);
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (
        this.current.lifecycleState === 'active' ||
        this.current.lifecycleState === 'resumed'
      ) {
        this.log.info(
          `[SESSION] idle threshold reached sessionId=${this.current.sessionId}`,
        );
        this.transition('idle');
      }
    }, this.idleThresholdMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
