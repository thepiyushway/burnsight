import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TelemetrySourceClassifier } from './TelemetrySourceClassifier';

export interface CopilotTelemetryFileMetadata {
  sourcePath: string;
  sourceType: string;
  discoveryTimestamp: number;
  validationConfidence: number;
  matchedSignatures: string[];
}

interface ValidationCacheEntry {
  size: number;
  mtimeMs: number;
  metadata?: CopilotTelemetryFileMetadata;
}

const ALLOWED_EXTENSIONS = new Set(['.log', '.txt', '.copilotmd']);
const DISCOVERY_SCAN_LINE_LIMIT = 200;
const DISCOVERY_SCAN_BYTE_LIMIT = 512 * 1024;
const RESCAN_INTERVAL_MS = 30_000;
const FILE_CHANGE_DEBOUNCE_MS = 120;
const SESSION_DIR_REGEX = /^\d{8}T\d{6}$/;

export class CopilotLogDiscovery implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly validationCache = new Map<string, ValidationCacheEntry>();
  private readonly acceptedFiles = new Map<string, CopilotTelemetryFileMetadata>();
  private readonly watcherByFile = new Map<string, vscode.FileSystemWatcher>();
  private readonly nativeWatcherByFile = new Map<string, import('fs').FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly sourceClassifier = new TelemetrySourceClassifier();

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly extensionLogPath: string
  ) {}

  public start(onValidatedFileEvent: (filePath: string, metadata: CopilotTelemetryFileMetadata) => void): void {
    this.runDiscovery(onValidatedFileEvent);

    this.rescanTimer = setInterval(() => {
      this.runDiscovery(onValidatedFileEvent);
    }, RESCAN_INTERVAL_MS);
  }

  public getAcceptedFiles(): CopilotTelemetryFileMetadata[] {
    return [...this.acceptedFiles.values()];
  }

  public dispose(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    vscode.Disposable.from(...this.subscriptions).dispose();
    for (const watcher of this.watcherByFile.values()) {
      watcher.dispose();
    }
    this.watcherByFile.clear();

    for (const nativeWatcher of this.nativeWatcherByFile.values()) {
      try {
        nativeWatcher.close();
      } catch {
        // ignore close errors
      }
    }
    this.nativeWatcherByFile.clear();
  }

  private runDiscovery(
    onValidatedFileEvent: (filePath: string, metadata: CopilotTelemetryFileMetadata) => void
  ): void {
    const roots = this.getMacOsRoots();
    const newlyAccepted: CopilotTelemetryFileMetadata[] = [];

    for (const root of roots) {
      this.log.info(`[DISCOVERY] scanning root: ${root}`);
      if (!fs.existsSync(root)) {
        continue;
      }

      const sessionDirs = this.safeReadDir(root)
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name));

      const activeSessionDir = this.resolveActiveSessionDir(sessionDirs);
      if (!activeSessionDir) {
        continue;
      }

      for (const sessionDir of sessionDirs) {
        if (sessionDir === activeSessionDir) {
          continue;
        }
        this.log.info(`[SESSION] ignored historical session: ${sessionDir}`);
      }

      this.log.info(`[SESSION] active session dir: ${activeSessionDir}`);

      const activeWindowDir = this.resolveActiveWindowDir(activeSessionDir);
      if (!activeWindowDir) {
        continue;
      }

      this.walkDirectory(activeWindowDir, (filePath) => {
        const metadata = this.validateTelemetryFile(filePath);
        if (!metadata) {
          return;
        }

        if (!this.acceptedFiles.has(filePath)) {
          newlyAccepted.push(metadata);
          this.acceptedFiles.set(filePath, metadata);
        }
      });
    }

    this.log.info(`[DISCOVERY] total accepted files: ${this.acceptedFiles.size}`);

    for (const metadata of newlyAccepted) {
      this.attachWatcher(metadata, onValidatedFileEvent);
      onValidatedFileEvent(metadata.sourcePath, metadata);
    }

    // On every rescan (30-second interval), also poll already-accepted files for
    // any content that the watchers may have missed. readNewContent is append-only
    // and idempotent — it returns immediately if there are no new bytes.
    if (newlyAccepted.length === 0) {
      for (const [filePath, metadata] of this.acceptedFiles.entries()) {
        this.log.info(`[DISCOVERY] rescan poll for known file file=${filePath}`);
        onValidatedFileEvent(filePath, metadata);
      }
    }
  }

  private getMacOsRoots(): string[] {
    if (process.platform !== 'darwin') {
      // Future support path: Windows/Linux/Cursor/Windsurf/VSCodium roots.
      return [];
    }

    return [path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'logs')];
  }

  private walkDirectory(dirPath: string, onFile: (filePath: string) => void): void {
    for (const entry of this.safeReadDir(dirPath)) {
      const childPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.walkDirectory(childPath, onFile);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      onFile(childPath);
    }
  }

  private validateTelemetryFile(filePath: string): CopilotTelemetryFileMetadata | undefined {
    this.log.info(`[DISCOVERY] validating: ${filePath}`);

    const extension = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      this.log.info(`[DISCOVERY] rejected: ${filePath}`);
      return undefined;
    }

    const stat = this.safeStat(filePath);
    if (!stat) {
      this.log.info(`[DISCOVERY] rejected: ${filePath}`);
      return undefined;
    }

    const cacheEntry = this.validationCache.get(filePath);
    if (cacheEntry && cacheEntry.size === stat.size && cacheEntry.mtimeMs === stat.mtimeMs) {
      if (cacheEntry.metadata) {
        return cacheEntry.metadata;
      }
      this.log.info(`[DISCOVERY] rejected: ${filePath}`);
      return undefined;
    }

    const lines = this.readTailLines(filePath, DISCOVERY_SCAN_LINE_LIMIT, DISCOVERY_SCAN_BYTE_LIMIT);
    const normalized = lines.join('\n').toLowerCase();

    const classification = this.sourceClassifier.classify(filePath, normalized);
    if (!classification.accepted) {
      this.validationCache.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      this.log.info(`[DISCOVERY] rejected: ${filePath} reason=${classification.reason}`);
      return undefined;
    }

    const matchedSignatures = classification.matchedSignatureTokens;
    this.log.info(`[DISCOVERY] accepted source: ${filePath} reason=${classification.reason}`);

    const metadata: CopilotTelemetryFileMetadata = {
      sourcePath: filePath,
      sourceType: this.getSourceType(filePath),
      discoveryTimestamp: Date.now(),
      validationConfidence: Math.min(1, 0.5 + matchedSignatures.length / 10),
      matchedSignatures,
    };

    this.validationCache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      metadata,
    });

    this.log.info(`[DISCOVERY] accepted: ${filePath}`);
    return metadata;
  }

  private resolveActiveSessionDir(sessionDirs: string[]): string | undefined {
    const sessionCandidates = sessionDirs
      .map((sessionDir) => ({
        sessionDir,
        score: this.parseSessionDirectoryScore(path.basename(sessionDir)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (sessionCandidates.length > 0) {
      return sessionCandidates[0].sessionDir;
    }

    const fallback = sessionDirs
      .map((sessionDir) => ({
        sessionDir,
        mtimeMs: this.safeStat(sessionDir)?.mtimeMs ?? 0,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return fallback[0]?.sessionDir;
  }

  private resolveActiveWindowDir(sessionDir: string): string | undefined {
    const dirs = this.safeReadDir(sessionDir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(sessionDir, entry.name));

    const windowDirs = dirs.filter((candidate) => this.getWindowRank(candidate) >= 0);
    if (windowDirs.length === 0) {
      return undefined;
    }

    const mostRecentlyActiveTelemetryWindow = windowDirs
      .map((candidate) => ({
        windowDir: candidate,
        telemetryMtimeMs: this.getWindowTelemetryMtime(candidate),
      }))
      .sort((left, right) => right.telemetryMtimeMs - left.telemetryMtimeMs)[0];

    const preferredFromExtensionPath = windowDirs.find((candidate) =>
      this.extensionLogPath.toLowerCase().includes(candidate.toLowerCase())
    );

    const fallbackWindowDir =
      preferredFromExtensionPath ??
      windowDirs
        .sort((left, right) => {
          const rankDelta = this.getWindowRank(right) - this.getWindowRank(left);
          if (rankDelta !== 0) {
            return rankDelta;
          }

          const rightMtime = this.safeStat(right)?.mtimeMs ?? 0;
          const leftMtime = this.safeStat(left)?.mtimeMs ?? 0;
          return rightMtime - leftMtime;
        })[0];

    const activeWindowDir =
      (mostRecentlyActiveTelemetryWindow?.telemetryMtimeMs ?? 0) > 0
        ? mostRecentlyActiveTelemetryWindow.windowDir
        : fallbackWindowDir;

    this.log.info(`[WINDOW] active window selected: ${activeWindowDir}`);
    for (const windowDir of windowDirs) {
      if (windowDir === activeWindowDir) {
        continue;
      }
      this.log.info(`[WINDOW] ignored inactive window: ${windowDir}`);
    }

    return activeWindowDir;
  }

  private attachWatcher(
    metadata: CopilotTelemetryFileMetadata,
    onValidatedFileEvent: (filePath: string, metadata: CopilotTelemetryFileMetadata) => void
  ): void {
    const filePath = metadata.sourcePath;
    if (this.watcherByFile.has(filePath)) {
      return;
    }

    const scheduleRead = () => {
      this.log.info(`[WATCHER] fs.watch callback fired file=${filePath}`);
      const existing = this.debounceTimers.get(filePath);
      if (existing) {
        clearTimeout(existing);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.log.info(`[WATCHER] debounced read scheduled file=${filePath}`);
        onValidatedFileEvent(filePath, metadata);
      }, FILE_CHANGE_DEBOUNCE_MS);

      this.debounceTimers.set(filePath, timer);
    };

    // PRIMARY: Node.js native fs.watch — direct OS FSEvents, reliable for any file path
    // including files outside VS Code workspace roots where createFileSystemWatcher
    // may silently miss change events.
    try {
      const nativeWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        this.log.info(`[WATCHER] native fs.watch event=${eventType} file=${filePath}`);
        scheduleRead();
      });
      nativeWatcher.on('error', (err) => {
        this.log.warn(`[WATCHER] native fs.watch error file=${filePath}: ${String(err)}`);
      });
      this.nativeWatcherByFile.set(filePath, nativeWatcher);
      this.log.info(`[WATCHER] native fs.watch attached file=${filePath}`);
    } catch (err) {
      this.log.warn(`[WATCHER] native fs.watch attach failed file=${filePath}: ${String(err)}`);
    }

    // SECONDARY: VS Code FileSystemWatcher — kept for integration, may not fire
    // reliably outside workspace folders but provides additional coverage.
    const vscodeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), path.basename(filePath))
    );

    vscodeWatcher.onDidChange(() => {
      this.log.info(`[WATCHER] vscode watcher onDidChange fired file=${filePath}`);
      scheduleRead();
    });
    vscodeWatcher.onDidCreate(() => {
      this.log.info(`[WATCHER] vscode watcher onDidCreate fired file=${filePath}`);
      scheduleRead();
    });

    this.watcherByFile.set(filePath, vscodeWatcher);
    this.subscriptions.push(vscodeWatcher);
    this.log.info(`[WATCHER] vscode watcher attached file=${filePath}`);
  }

  private getSourceType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.copilotmd') {
      return 'copilot-session-artifact';
    }
    return 'copilot-runtime-log';
  }

  private readTailLines(filePath: string, maxLines: number, maxBytes: number): string[] {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stats = fs.fstatSync(fd);
      const readBytes = Math.min(stats.size, maxBytes);
      if (readBytes <= 0) {
        return [];
      }

      const buffer = Buffer.alloc(readBytes);
      const startPos = Math.max(0, stats.size - readBytes);
      fs.readSync(fd, buffer, 0, readBytes, startPos);
      const text = buffer.toString('utf-8');
      const lines = text.split(/\r?\n/);
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  }

  private parseSessionDirectoryScore(sessionName: string): number {
    if (!SESSION_DIR_REGEX.test(sessionName)) {
      return 0;
    }

    const year = Number.parseInt(sessionName.slice(0, 4), 10);
    const month = Number.parseInt(sessionName.slice(4, 6), 10);
    const day = Number.parseInt(sessionName.slice(6, 8), 10);
    const hour = Number.parseInt(sessionName.slice(9, 11), 10);
    const minute = Number.parseInt(sessionName.slice(11, 13), 10);
    const second = Number.parseInt(sessionName.slice(13, 15), 10);
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  private getWindowRank(windowDir: string): number {
    const basename = path.basename(windowDir).toLowerCase();
    const match = /^window(\d+)$/.exec(basename);
    if (!match) {
      return -1;
    }
    return Number.parseInt(match[1], 10);
  }

  private getWindowTelemetryMtime(windowDir: string): number {
    const candidatePaths = [
      path.join(windowDir, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'),
      path.join(windowDir, 'exthost', 'GitHub.copilot', 'GitHub Copilot.log'),
    ];

    return candidatePaths.reduce((latest, candidatePath) => {
      const stat = this.safeStat(candidatePath);
      return Math.max(latest, stat?.mtimeMs ?? 0);
    }, 0);
  }

  private safeReadDir(dirPath: string): fs.Dirent[] {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private safeStat(filePath: string): fs.Stats | undefined {
    try {
      return fs.statSync(filePath);
    } catch {
      return undefined;
    }
  }
}
