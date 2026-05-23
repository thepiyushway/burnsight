import * as vscode from 'vscode';
import * as fs from 'fs';
import { CopilotLogEvent, BurnSightEvents } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';
import * as Patterns from './LogPatterns';
import {
  CopilotLogDiscovery,
  CopilotTelemetryFileMetadata,
} from '../telemetry/discovery/CopilotLogDiscovery';
import { TelemetrySourceClassifier } from '../telemetry/discovery/TelemetrySourceClassifier';

/**
 * Observes GitHub Copilot Chat log files and emits parsed CopilotLogEvent
 * instances onto the event bus.
 *
 * Discovery is delegated to CopilotLogDiscovery, which recursively scans VS Code
 * log roots and validates files by telemetry content signatures (not file names
 * or folder conventions). Only validated files are watched and ingested.
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
  private readonly acceptedWatcherPaths = new Set<string>();
  private readonly discovery: CopilotLogDiscovery;
  private readonly sourceClassifier = new TelemetrySourceClassifier();
  private readonly fileMetadata = new Map<string, CopilotTelemetryFileMetadata>();
  private readonly checkpointKey = 'burnsight.copilotLogParser.checkpoints';

  private readonly hardIgnoreTokens = [
    'burnsight',
    'runtimeinspector',
    'extension-output',
    'outputchannel',
    'output channels',
  ] as const;

  constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    log: vscode.LogOutputChannel,
    private readonly extensionLogPath: string,
    private readonly checkpointStore?: vscode.Memento
  ) {
    this.log = log;
    this.discovery = new CopilotLogDiscovery(this.log, this.extensionLogPath);
    this.log.info('[CopilotLogParser] Initializing');
    this.discoverAndWatch();
  }

  // --------------------------------------------------------------------------
  // Discovery
  // --------------------------------------------------------------------------

  private discoverAndWatch(): void {
    this.log.info(`[CopilotLogParser] Discovery anchored from extension log path: ${this.extensionLogPath}`);
    this.discovery.start((filePath, metadata) => {
      this.fileMetadata.set(filePath, metadata);
      const isFirstAttach = !this.acceptedWatcherPaths.has(filePath);
      this.acceptedWatcherPaths.add(filePath);
      if (isFirstAttach) {
        this.attachTailAtEof(filePath);
      } else {
        this.readNewContent(filePath);
      }
      this.logAcceptedWatcherSummary();
    });

    if (this.discovery.getAcceptedFiles().length === 0) {
      this.log.warn('[CopilotLogParser] Recursive scan completed with zero validated telemetry files.');
    }
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
    if (this.shouldIgnoreFile(filePath)) {
      this.log.info(`[WATCHER] ignored self-log: ${filePath}`);
      return;
    }

    try {
      const stats = fs.statSync(filePath);
      const checkpointPos = this.getCheckpoint(filePath);
      const inMemoryPos = this.filePositions.get(filePath) ?? stats.size;
      const lastPos = Math.min(stats.size, Math.max(checkpointPos, inMemoryPos));
      if (stats.size <= lastPos) {
        this.filePositions.set(filePath, stats.size);
        this.saveCheckpoint(filePath, stats.size);
        return; // no new bytes
      }

      const length = stats.size - lastPos;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, length, lastPos);
      fs.closeSync(fd);

      this.log.info(`[TAILER] appended bytes=${length} file=${filePath}`);

      this.filePositions.set(filePath, stats.size);
      this.saveCheckpoint(filePath, stats.size);

      const newContent = (this.fileRemainders.get(filePath) ?? '') + buffer.toString('utf-8');
      const lines = newContent.split(/\r?\n/);
      const trailing = lines.pop() ?? '';
      this.fileRemainders.set(filePath, trailing);

      let offsetCursor = lastPos;
      for (const line of lines) {
        const trimmed = line.trim();
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        const lineOffset = offsetCursor;
        offsetCursor += lineBytes;

        if (trimmed.length > 0) {
          this.parseLine(trimmed, filePath, lineOffset);
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
  private parseLine(line: string, sourceFile: string, fileOffset: number): void {
    if (this.shouldIgnoreSourceLine(sourceFile, line)) {
      return;
    }

    if (!Patterns.isRelevantLine(line)) {
      return;
    }

    const sourceClassification = this.sourceClassifier.classify(sourceFile, line);
    if (!sourceClassification.accepted) {
      return;
    }

    const fingerprint = this.createFingerprint(line, sourceFile);
    if (this.isDuplicateFingerprint(fingerprint)) {
      return;
    }

    const canonicalMatch = Patterns.CANONICAL_EVENT.exec(line);

    const hasRequestDone = Patterns.REQUEST_DONE.test(line);
    const hasModel = Patterns.MODEL_NAME.test(line);
    const hasLatency = Patterns.LATENCY_MS.test(line);
    const hasFinishReason = Patterns.FINISH_REASON.test(line);
    const hasArtifact = Patterns.SESSION_ARTIFACT.test(line);
    const hasProvider = Patterns.PROVIDER.test(line);

    let stage: CopilotLogEvent['stage'] = 'other';
    if (canonicalMatch) {
      stage = 'request_done';
    } else if (hasRequestDone) {
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

    const requestIdFromCanonical = canonicalMatch?.[1];
    const requestIdFromLine = Patterns.REQUEST_ID.exec(line)?.[1];
    const requestId =
      requestIdFromCanonical ?? requestIdFromLine ?? `unknown-${Date.now()}-${Math.abs(hashCode(line))}`;

    const event: CopilotLogEvent = {
      timestamp: Date.now(),
      // Truncate to 200 chars to keep the ring buffer compact
      raw: line.length > 200 ? line.slice(0, 197) + '…' : line,
      rawLine: line,
      requestId,
      requestDone: hasRequestDone,
      observedChars: line.length,
      sourceFile,
      fileOffset,
      stage,
      fingerprint,
      sourceType: this.fileMetadata.get(sourceFile)?.sourceType,
    };

    if (canonicalMatch) {
      event.success = canonicalMatch[2].toLowerCase() === 'success';
      event.model = canonicalMatch[3];
      event.latencyMs = parseInt(canonicalMatch[4], 10);
      event.sessionArtifact = `${canonicalMatch[1]}.copilotmd`;
      event.sourceType = this.normalizeSourceType(canonicalMatch[5]);
      event.requestDone = true;
    }

    const modelMatch = Patterns.MODEL_NAME.exec(line);
    if (modelMatch) {
      event.model = modelMatch[1];
    }

    const latencyMatch = Patterns.LATENCY_MS.exec(line);
    if (latencyMatch) {
      event.latencyMs = parseInt(latencyMatch[1], 10);
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

    const sourceTypeMatch = Patterns.SOURCE_TYPE_BRACKET.exec(line);
    if (!event.sourceType && sourceTypeMatch) {
      event.sourceType = this.normalizeSourceType(sourceTypeMatch[1]);
    }

    if (event.success === undefined && hasRequestDone) {
      event.success = true;
    }

    this.log.info(
      `[PARSER] accepted copilot event requestId=${event.requestId} stage=${event.stage} fileOffset=${fileOffset}`
    );
    this.bus.emit('copilot.request', event);
  }

  private attachTailAtEof(filePath: string): void {
    if (this.shouldIgnoreFile(filePath)) {
      this.log.info(`[TAILER] ignored file attach: ${filePath}`);
      return;
    }

    try {
      const stats = fs.statSync(filePath);
      const eofOffset = stats.size;
      this.filePositions.set(filePath, eofOffset);
      this.fileRemainders.set(filePath, '');
      this.saveCheckpoint(filePath, eofOffset);
      this.log.info(`[TAILER] attached eof offset=${eofOffset} file=${filePath}`);
    } catch (err) {
      this.log.warn(`[TAILER] attach failed file=${filePath} err=${String(err)}`);
    }
  }

  private getCheckpoint(filePath: string): number {
    const checkpoints = this.checkpointStore?.get<Record<string, number>>(this.checkpointKey) ?? {};
    return checkpoints[filePath] ?? 0;
  }

  private saveCheckpoint(filePath: string, offset: number): void {
    if (!this.checkpointStore) {
      return;
    }

    const checkpoints = this.checkpointStore.get<Record<string, number>>(this.checkpointKey) ?? {};
    checkpoints[filePath] = offset;
    void this.checkpointStore.update(this.checkpointKey, checkpoints);
  }

  private normalizeSourceType(rawSource: string): CopilotLogEvent['sourceType'] {
    const source = rawSource.trim();
    if (source === 'panel/editAgent') {
      return 'panel/editAgent';
    }
    if (source === 'copilotLanguageModelWrapper') {
      return 'copilotLanguageModelWrapper';
    }
    if (source === 'title') {
      return 'title';
    }
    if (source === 'progressMessages') {
      return 'progressMessages';
    }
    return source || 'unknown';
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

  private shouldIgnoreFile(filePath: string): boolean {
    const normalized = filePath.toLowerCase();
    const hasHardIgnoreToken = this.hardIgnoreTokens.some((token) => normalized.includes(token));
    return hasHardIgnoreToken;
  }

  private shouldIgnoreSourceLine(sourceFile: string, line: string): boolean {
    const source = sourceFile.toLowerCase();
    const raw = line.toLowerCase();

    if (source.includes('burnsight')) {
      return true;
    }

    if (
      raw.includes('burnsight') ||
      raw.includes('runtimeinspector') ||
      raw.includes('burnsight telemetry')
    ) {
      return true;
    }

    return false;
  }

  private logAcceptedWatcherSummary(): void {
    const accepted = [...this.acceptedWatcherPaths];
    if (accepted.length === 0) {
      this.log.warn('[WATCHER] accepted watcher paths: none');
      return;
    }

    this.log.info(`[WATCHER] accepted watcher paths (${accepted.length}):`);
    for (const watcherPath of accepted) {
      this.log.info(`[WATCHER] accepted copilot-log: ${watcherPath}`);
    }
  }

  // --------------------------------------------------------------------------
  // Disposal
  // --------------------------------------------------------------------------

  public dispose(): void {
    this.discovery.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}

function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
