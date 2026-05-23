import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

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
const TELEMETRY_SIGNATURES = [
  'ccreq:',
  'request done:',
  'message 0 returned',
  'copilotcli',
  'copilotclichatsessioncontentprovider',
  'conversationfeature',
  'model deployment id',
  'copilotmd',
] as const;

const DISCOVERY_SCAN_LINE_LIMIT = 200;
const DISCOVERY_SCAN_BYTE_LIMIT = 512 * 1024;
const RESCAN_INTERVAL_MS = 30_000;
const FILE_CHANGE_DEBOUNCE_MS = 120;

export class CopilotLogDiscovery implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly validationCache = new Map<string, ValidationCacheEntry>();
  private readonly acceptedFiles = new Map<string, CopilotTelemetryFileMetadata>();
  private readonly watcherByFile = new Map<string, vscode.FileSystemWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private rescanTimer: NodeJS.Timeout | undefined;

  private readonly denylistTokens = [
    'burnsight',
    'telemetry',
    'runtimeinspector',
    'extension-output',
    'output channels',
    'outputchannel',
  ] as const;

  constructor(private readonly log: vscode.LogOutputChannel) {}

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

      for (const sessionDir of sessionDirs) {
        this.log.info(`[DISCOVERY] session dir: ${sessionDir}`);
        this.walkDirectory(sessionDir, (filePath) => {
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
    }

    this.log.info(`[DISCOVERY] total accepted files: ${this.acceptedFiles.size}`);

    for (const metadata of newlyAccepted) {
      this.attachWatcher(metadata, onValidatedFileEvent);
      onValidatedFileEvent(metadata.sourcePath, metadata);
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
        if (this.isDeniedPath(childPath)) {
          continue;
        }
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

    if (this.isDeniedPath(filePath)) {
      this.log.info(`[DISCOVERY] rejected: ${filePath}`);
      return undefined;
    }

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

    const lines = this.readFirstLines(filePath, DISCOVERY_SCAN_LINE_LIMIT, DISCOVERY_SCAN_BYTE_LIMIT);
    const normalized = lines.join('\n').toLowerCase();
    const matchedSignatures = TELEMETRY_SIGNATURES.filter((signature) => normalized.includes(signature));

    if (matchedSignatures.length === 0) {
      this.validationCache.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      this.log.info(`[DISCOVERY] rejected: ${filePath}`);
      return undefined;
    }

    this.log.info(
      `[DISCOVERY] telemetry signature matched: ${filePath} -> ${matchedSignatures.join(', ')}`
    );

    const metadata: CopilotTelemetryFileMetadata = {
      sourcePath: filePath,
      sourceType: this.getSourceType(filePath),
      discoveryTimestamp: Date.now(),
      validationConfidence: Math.min(1, 0.5 + matchedSignatures.length / TELEMETRY_SIGNATURES.length),
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

  private attachWatcher(
    metadata: CopilotTelemetryFileMetadata,
    onValidatedFileEvent: (filePath: string, metadata: CopilotTelemetryFileMetadata) => void
  ): void {
    const filePath = metadata.sourcePath;
    if (this.watcherByFile.has(filePath)) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), path.basename(filePath))
    );

    const scheduleRead = () => {
      const existing = this.debounceTimers.get(filePath);
      if (existing) {
        clearTimeout(existing);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        onValidatedFileEvent(filePath, metadata);
      }, FILE_CHANGE_DEBOUNCE_MS);

      this.debounceTimers.set(filePath, timer);
    };

    watcher.onDidChange(() => scheduleRead());
    watcher.onDidCreate(() => scheduleRead());

    this.watcherByFile.set(filePath, watcher);
    this.subscriptions.push(watcher);
    this.log.info(`[DISCOVERY] watcher attached: ${filePath}`);
  }

  private isDeniedPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return this.denylistTokens.some((token) => lower.includes(token));
  }

  private getSourceType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.copilotmd') {
      return 'copilot-session-artifact';
    }
    return 'copilot-runtime-log';
  }

  private readFirstLines(filePath: string, maxLines: number, maxBytes: number): string[] {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stats = fs.fstatSync(fd);
      const readBytes = Math.min(stats.size, maxBytes);
      if (readBytes <= 0) {
        return [];
      }

      const buffer = Buffer.alloc(readBytes);
      fs.readSync(fd, buffer, 0, readBytes, 0);
      const text = buffer.toString('utf-8');
      const lines = text.split(/\r?\n/);
      return lines.slice(0, maxLines);
    } finally {
      fs.closeSync(fd);
    }
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
