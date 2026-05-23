import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  SessionTelemetry,
  SessionIndexEntry,
} from '../domain/SessionTelemetry';
import { InteractionTrace } from '../domain/InteractionTrace';
import { AggregateTelemetryEngine } from '../analytics/AggregateTelemetryEngine';

type SessionUpdateListener = (session: SessionTelemetry) => void;

const SAVE_DEBOUNCE_MS = 500;
const SESSIONS_DIR = 'sessions';
const INDEX_FILE = 'index.json';
const CURRENT_SCHEMA_VERSION = 2;

interface SessionIndex {
  schemaVersion: number;
  sessions: SessionIndexEntry[];
}

/**
 * Local-first persistent store for BurnSight session telemetry.
 *
 * Storage layout:
 *   {globalStorageUri}/sessions/{sessionId}.json        — session data
 *   {globalStorageUri}/sessions/index.json              — session index
 *   {globalStorageUri}/sessions/{sessionId}.json.tmp    — atomic write temp
 *
 * Session lifecycle:
 *   - One session per calendar day (key: 'session-YYYY-MM-DD').
 *   - Loaded from disk on extension activation — survives VS Code restarts.
 *   - Persisted asynchronously after each trace append (debounced 500ms).
 *
 * Persistence guarantees:
 *   - Atomic writes via tmp-then-rename: corrupt partial writes are prevented.
 *   - Schema version checked on load; v1 sessions are migrated to v2 on read.
 *   - Session index maintained for historical lookup.
 *
 * Privacy guarantees:
 *   - Raw prompts and responses are NEVER stored.
 *   - Only hashes, lengths, tokens, models, workflows, and metrics persist.
 */
export class SessionStore implements vscode.Disposable {
  private readonly storageDir: string;
  private session: SessionTelemetry;
  private readonly updateListeners: SessionUpdateListener[] = [];
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly aggregateEngine = new AggregateTelemetryEngine();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly provider = 'github-copilot',
  ) {
    this.storageDir = path.join(context.globalStorageUri.fsPath, SESSIONS_DIR);
    this.session = this.loadOrCreate();
    this.log.info(
      `[SessionStore] active session=${this.session.sessionId} interactions=${this.session.interactions.length} schema=${this.session.schemaVersion ?? 1}`,
    );
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Returns the current in-memory session (may have unsaved changes). */
  public getSession(): SessionTelemetry {
    return this.session;
  }

  /**
   * Append or update an InteractionTrace in the current session.
   * Idempotent: if a trace with the same traceId already exists it is replaced.
   * Triggers aggregate recomputation and notifies all listeners synchronously.
   */
  public appendTrace(trace: InteractionTrace): void {
    const interactions = [...this.session.interactions];
    const existing = interactions.findIndex((i) => i.traceId === trace.traceId);
    if (existing >= 0) {
      interactions[existing] = trace;
    } else {
      interactions.push(trace);
    }

    this.session = {
      ...this.session,
      interactions,
      updatedAt: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      aggregateMetrics: this.aggregateEngine.computeMetrics(
        interactions,
        this.session.startedAt,
      ),
    };

    this.notifyListeners();
    this.scheduleSave();
  }

  /**
   * List all persisted session IDs, newest first.
   * Prefers the index file if available; falls back to directory scan.
   */
  public listSessionIds(): string[] {
    const index = this.loadIndex();
    if (index && index.sessions.length > 0) {
      return index.sessions
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((s) => s.sessionId);
    }
    // Fall back to directory scan
    try {
      if (!fs.existsSync(this.storageDir)) {
        return [];
      }
      return fs
        .readdirSync(this.storageDir)
        .filter((f) => f.endsWith('.json') && f !== INDEX_FILE)
        .map((f) => f.slice(0, -5))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Load a specific session by ID from disk.
   * Returns undefined if not found or corrupted.
   */
  public loadSession(sessionId: string): SessionTelemetry | undefined {
    const filePath = this.sessionPath(sessionId);
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const loaded = JSON.parse(raw) as SessionTelemetry;
      return this.migrateIfNeeded(loaded);
    } catch (err) {
      this.log.warn(`[SessionStore] loadSession failed id=${sessionId} err=${String(err)}`);
      return undefined;
    }
  }

  /** Register a listener that fires whenever the session is updated. */
  public onSessionUpdated(listener: SessionUpdateListener): { dispose: () => void } {
    this.updateListeners.push(listener);
    return {
      dispose: () => {
        const idx = this.updateListeners.indexOf(listener);
        if (idx >= 0) {
          this.updateListeners.splice(idx, 1);
        }
      },
    };
  }

  /** Flush any pending writes and release resources. */
  public dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.persistToDisk(); // synchronous flush on teardown
    }
  }

  // --------------------------------------------------------------------------
  // Load / create
  // --------------------------------------------------------------------------

  private loadOrCreate(): SessionTelemetry {
    const sessionId = this.buildSessionId();
    const filePath = this.sessionPath(sessionId);

    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const loaded = JSON.parse(raw) as SessionTelemetry;
        const migrated = this.migrateIfNeeded(loaded);
        this.log.info(
          `[SessionStore] loaded session=${sessionId} traces=${migrated.interactions.length}`,
        );
        return migrated;
      }
    } catch (err) {
      this.log.warn(
        `[SessionStore] load failed session=${sessionId} err=${String(err)} — creating fresh`,
      );
    }

    const fresh: SessionTelemetry = {
      sessionId,
      provider: this.provider,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      interactions: [],
      aggregateMetrics: this.aggregateEngine.emptyMetrics(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      metadata: {
        vsCodeVersion: vscode.version,
        extensionVersion: String(
          (this.context.extension.packageJSON as Record<string, unknown>).version ?? '',
        ) || undefined,
        workspaceName: vscode.workspace.name,
        os: process.platform,
      },
    };

    this.log.info(`[SessionStore] created new session=${sessionId}`);
    return fresh;
  }

  // --------------------------------------------------------------------------
  // Schema migration
  // --------------------------------------------------------------------------

  private migrateIfNeeded(session: SessionTelemetry): SessionTelemetry {
    const version = session.schemaVersion ?? 1;
    if (version >= CURRENT_SCHEMA_VERSION) {
      return session;
    }

    this.log.info(
      `[SessionStore] migrating session=${session.sessionId} from v${version} to v${CURRENT_SCHEMA_VERSION}`,
    );

    // v1 → v2: Add semantic aggregate fields (totalInternalOperations, etc.)
    const migratedMetrics = {
      ...session.aggregateMetrics,
      totalInternalOperations:
        (session.aggregateMetrics as { totalInternalOperations?: number }).totalInternalOperations
        ?? session.interactions.reduce((s, t) => s + t.spans.length, 0),
      hiddenInferenceCount:
        (session.aggregateMetrics as { hiddenInferenceCount?: number }).hiddenInferenceCount ?? 0,
      orchestrationOverheadRatio:
        (session.aggregateMetrics as { orchestrationOverheadRatio?: number }).orchestrationOverheadRatio ?? 0,
    };

    return {
      ...session,
      aggregateMetrics: migratedMetrics,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
  }

  // --------------------------------------------------------------------------
  // Persistence — atomic write via tmp → rename
  // --------------------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.persistToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private persistToDisk(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      const filePath = this.sessionPath(this.session.sessionId);
      const tmpPath = `${filePath}.tmp`;

      // Atomic write: write to .tmp, then rename
      fs.writeFileSync(tmpPath, JSON.stringify(this.session, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);

      this.log.info(`[SessionStore] persisted session=${this.session.sessionId} interactions=${this.session.interactions.length}`);
      this.persistIndex();
    } catch (err) {
      this.log.warn(`[SessionStore] persist failed: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Session index — lightweight metadata for all sessions
  // --------------------------------------------------------------------------

  private persistIndex(): void {
    try {
      const index = this.loadIndex() ?? { schemaVersion: 1, sessions: [] };
      const entry: SessionIndexEntry = {
        sessionId: this.session.sessionId,
        startedAt: this.session.startedAt,
        updatedAt: this.session.updatedAt,
        interactionCount: this.session.aggregateMetrics.totalInteractions,
        internalOperationCount: this.session.aggregateMetrics.totalInternalOperations,
        estimatedTotalCostUsd: this.session.aggregateMetrics.estimatedTotalCostUsd,
        workspaceName: this.session.metadata.workspaceName,
      };

      const existing = index.sessions.findIndex(
        (s) => s.sessionId === entry.sessionId,
      );
      if (existing >= 0) {
        index.sessions[existing] = entry;
      } else {
        index.sessions.push(entry);
      }

      const indexPath = path.join(this.storageDir, INDEX_FILE);
      const tmpIndexPath = `${indexPath}.tmp`;
      fs.writeFileSync(tmpIndexPath, JSON.stringify(index, null, 2), 'utf-8');
      fs.renameSync(tmpIndexPath, indexPath);
    } catch (err) {
      this.log.warn(`[SessionStore] index update failed: ${String(err)}`);
    }
  }

  private loadIndex(): SessionIndex | undefined {
    const indexPath = path.join(this.storageDir, INDEX_FILE);
    try {
      if (!fs.existsSync(indexPath)) {
        return undefined;
      }
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SessionIndex;
    } catch {
      return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Listeners
  // --------------------------------------------------------------------------

  private notifyListeners(): void {
    for (const listener of this.updateListeners) {
      listener(this.session);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Daily session key: 'session-YYYY-MM-DD'. Stable across restarts. */
  private buildSessionId(): string {
    return `session-${new Date().toISOString().slice(0, 10)}`;
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.storageDir, `${sessionId}.json`);
  }
}
