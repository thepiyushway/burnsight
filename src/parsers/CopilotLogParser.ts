import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CopilotLogEvent, BurnSightEvents } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';
import * as Patterns from './LogPatterns';

/**
 * Observes GitHub Copilot Chat log files and emits parsed CopilotLogEvent
 * instances onto the event bus.
 *
 * ARCHITECTURAL ASSUMPTION:
 * VSCode stores all extension host logs for a session in sibling directories
 * under the exthost log folder. Our extension context provides a log path:
 *   .../logs/<session>/exthost<N>/buildingpiyush.burnsight/
 *
 * By navigating two levels up we reach the session root:
 *   .../logs/<session>/
 *
 * We then scan that directory for any subfolder whose name contains "copilot"
 * (case-insensitive) to locate GitHub Copilot / Copilot Chat logs.
 *
 * If no Copilot log directory is found (e.g. Copilot is not installed or the
 * log path layout differs) the parser remains idle.  All metrics default to
 * zero — no fake data is substituted.
 *
 * ONLY uses:
 *   - extension context log path (VS Code API)
 *   - vscode.workspace.createFileSystemWatcher (VS Code API)
 *   - Node fs.readSync with tracked byte offsets (no DOM, no browser hacks)
 */
export class CopilotLogParser implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly log: vscode.LogOutputChannel;
  /** Per-file byte position so we only read newly appended content */
  private readonly filePositions = new Map<string, number>();
  /** Per-file partial trailing text when a chunk ends mid-line */
  private readonly fileRemainders = new Map<string, string>();
  /** Recent line fingerprints to suppress duplicate emitted events */
  private readonly recentLineFingerprints = new Map<string, number>();
  private readonly dedupeWindowMs = 3000;

  constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    log: vscode.LogOutputChannel,
    private readonly extensionLogPath: string
  ) {
    this.log = log;
    this.log.info('[CopilotLogParser] Initializing');
    this.discoverAndWatch();
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  /**
  * Navigates from our extension log directory up to the session folder,
  * then scans recursively for Copilot log directories.
   */
  private discoverAndWatch(): void {
    try {
      const ourLogPath = this.extensionLogPath;
      // e.g. .../logs/<session>/exthost1/buildingpiyush.burnsight
      // sessionDir = .../logs/<session>
      const sessionDir = path.dirname(path.dirname(ourLogPath));
      this.log.info(`[CopilotLogParser] Scanning session dir: ${sessionDir}`);

      const copilotDirs = this.findCopilotLogDirs(sessionDir);

      if (copilotDirs.length === 0) {
        this.log.warn(
          '[CopilotLogParser] No Copilot log directories found. ' +
          'Ensure GitHub Copilot / Copilot Chat is installed and active. ' +
          'BurnSight will show zeros until log files appear.'
        );
        // Watch the session dir so we can detect directories created later
        this.watchForNewCopilotDirs(sessionDir);
        return;
      }

      for (const dir of copilotDirs) {
        this.watchDirectory(dir);
      }
    } catch (err) {
      this.log.error(`[CopilotLogParser] Discovery failed: ${String(err)}`);
    }
  }

  /** Returns all subdirectory paths whose name contains "copilot" */
  private findCopilotLogDirs(sessionDir: string): string[] {
    const results: string[] = [];

    const visit = (dir: string, depth: number): void => {
      if (depth > 5) {
        return;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childPath = path.join(dir, entry.name);
        if (/github\.copilot-chat/i.test(entry.name) || /copilot/i.test(entry.name)) {
          results.push(childPath);
        }
        visit(childPath, depth + 1);
      }
    };

    try {
      visit(sessionDir, 0);
      return [...new Set(results)];
    } catch {
      return [];
    }
  }

  /**
   * Watches the exthost directory for newly created subdirectories.
   * If a Copilot directory appears after activation, we start watching it.
   */
  private watchForNewCopilotDirs(sessionDir: string): void {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(sessionDir), '**/*')
      );
      watcher.onDidCreate((uri) => {
        try {
          if (fs.statSync(uri.fsPath).isDirectory() && /copilot/i.test(path.basename(uri.fsPath))) {
            this.log.info(`[CopilotLogParser] Copilot dir appeared: ${uri.fsPath}`);
            this.watchDirectory(uri.fsPath);
          }
        } catch {
          // ignore
        }
      });
      this.subscriptions.push(watcher);
    } catch {
      // Non-fatal — just means late-appearing directories won't be picked up
    }
  }

  // --------------------------------------------------------------------------
  // File watching
  // --------------------------------------------------------------------------

  /** Reads existing log files in the directory and installs a watcher. */
  private watchDirectory(dir: string): void {
    this.log.info(`[CopilotLogParser] Watching directory: ${dir}`);

    // Ingest any log lines already written before we started
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
      for (const file of files) {
        this.readNewContent(path.join(dir, file));
      }
    } catch { /* ignore — directory may be temporarily unavailable */ }

    // Watch for appended content going forward
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.log');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange((uri) => this.readNewContent(uri.fsPath));
    watcher.onDidCreate((uri) => this.readNewContent(uri.fsPath));
    this.subscriptions.push(watcher);
  }

  // --------------------------------------------------------------------------
  // Incremental file reading
  // --------------------------------------------------------------------------

  /**
   * Reads only content appended to a log file since the last read.
   * Maintains a per-file byte position to avoid re-processing old entries.
   * CONFIDENCE: REAL — we read raw bytes written by Copilot's log channel.
   */
  private readNewContent(filePath: string): void {
    try {
      const stats = fs.statSync(filePath);
      const lastPos = this.filePositions.get(filePath) ?? 0;
      if (stats.size <= lastPos) {
        return; // no new bytes
      }

      const length = stats.size - lastPos;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, length, lastPos);
      fs.closeSync(fd);

      this.filePositions.set(filePath, stats.size);

      const newContent = (this.fileRemainders.get(filePath) ?? '') + buffer.toString('utf-8');
      const lines = newContent.split(/\r?\n/);
      const trailing = lines.pop() ?? '';
      this.fileRemainders.set(filePath, trailing);

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          this.parseLine(trimmed, filePath);
        }
      }
    } catch (err) {
      this.log.warn(`[CopilotLogParser] Read error for ${filePath}: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Log line parsing
  // --------------------------------------------------------------------------

  /**
   * Parses a single log line into a CopilotLogEvent and emits it on the bus.
   * Only processes lines that contain at least one relevant telemetry field.
   * CONFIDENCE of extracted fields: REAL (see LogPatterns.ts for rationale).
   */
  private parseLine(line: string, sourceFile: string): void {
    if (!Patterns.isRelevantLine(line)) {
      return;
    }

    const fingerprint = this.createFingerprint(line, sourceFile);
    if (this.isDuplicateFingerprint(fingerprint)) {
      return;
    }

    const hasRequestDone = Patterns.REQUEST_DONE.test(line);
    const hasModel = Patterns.MODEL_NAME.test(line);
    const hasLatency = Patterns.LATENCY_MS.test(line);
    const hasFinishReason = Patterns.FINISH_REASON.test(line);
    const hasArtifact = Patterns.SESSION_ARTIFACT.test(line);
    const hasProvider = Patterns.PROVIDER.test(line);

    let stage: CopilotLogEvent['stage'] = 'other';
    if (hasRequestDone) {
      stage = 'request_done';
    } else if (hasFinishReason) {
      stage = 'finish_reason_seen';
    } else if (hasLatency) {
      stage = 'latency_seen';
    } else if (hasModel) {
      stage = 'model_seen';
    } else if (hasArtifact) {
      stage = 'artifact_seen';
    } else if (hasProvider) {
      stage = 'other';
    }

    const event: CopilotLogEvent = {
      timestamp: Date.now(),
      // Truncate to 200 chars to keep the ring buffer compact
      raw: line.length > 200 ? line.slice(0, 197) + '…' : line,
      requestDone: hasRequestDone,
      observedChars: line.length,
      sourceFile,
      stage,
      fingerprint,
    };

    const modelMatch = Patterns.MODEL_NAME.exec(line);
    if (modelMatch) {
      event.model = modelMatch[1];
    }

    const latencyMatch = Patterns.LATENCY_MS.exec(line);
    if (latencyMatch) {
      event.latencyMs = parseInt(latencyMatch[1], 10);
    }

    const requestIdMatch = Patterns.REQUEST_ID.exec(line);
    if (requestIdMatch) {
      event.requestId = requestIdMatch[1];
    }

    const finishReasonMatch = Patterns.FINISH_REASON.exec(line);
    if (finishReasonMatch) {
      event.finishReason = finishReasonMatch[1].toLowerCase();
    }

    const artifactMatch = Patterns.SESSION_ARTIFACT.exec(line);
    if (artifactMatch) {
      event.sessionArtifact = artifactMatch[1];
    }

    const providerMatch = Patterns.PROVIDER.exec(line);
    if (providerMatch) {
      event.provider = providerMatch[1].toLowerCase();
    }

    this.log.info(`[CopilotLogParser] event=${JSON.stringify(event)}`);
    this.bus.emit('copilot.request', event);
  }

  private createFingerprint(line: string, sourceFile: string): string {
    return `${sourceFile}|${line.slice(0, 220)}`;
  }

  private isDuplicateFingerprint(fingerprint: string): boolean {
    const now = Date.now();

    for (const [key, ts] of this.recentLineFingerprints.entries()) {
      if (now - ts > this.dedupeWindowMs) {
        this.recentLineFingerprints.delete(key);
      }
    }

    const previous = this.recentLineFingerprints.get(fingerprint);
    if (previous !== undefined && now - previous <= this.dedupeWindowMs) {
      return true;
    }

    this.recentLineFingerprints.set(fingerprint, now);
    return false;
  }

  // --------------------------------------------------------------------------
  // Disposal
  // --------------------------------------------------------------------------

  public dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}
