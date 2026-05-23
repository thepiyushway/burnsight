import * as vscode from 'vscode';
import {
  BurnSightEvents,
  RuntimeObservation,
  RuntimeSignal,
  RuntimeSignalType,
} from './types';
import { EventBus } from '../utils/EventBus';

interface ChangeWindow {
  timestamp: number;
  fileName: string;
  insertedChars: number;
}

interface ExecutedCommandEvent {
  command: string;
  arguments?: unknown[];
}

/**
 * RuntimeInspector observes VSCode editor events for CONTEXTUAL signals only.
 *
 * IMPORTANT: These signals do NOT drive any metric counters.
 * All actual metrics are derived from CopilotLogParser / copilot.request events.
 * Signals emitted here are for the debug panel and future extensibility only.
 *
 * Confidence of all signals emitted here: HEURISTIC.
 */
export class RuntimeInspector implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly lastInsertionAtByFile = new Map<string, number>();
  private readonly recentChanges: ChangeWindow[] = [];

  constructor(
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.log.info('[RuntimeInspector] Initialized');

    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChange(e))
    );

    const commandsWithEvent = vscode.commands as unknown as {
      onDidExecuteCommand?: vscode.Event<ExecutedCommandEvent>;
    };

    if (commandsWithEvent.onDidExecuteCommand) {
      this.subscriptions.push(
        commandsWithEvent.onDidExecuteCommand((e) => this.onCommand(e))
      );
    } else {
      this.log.info('[RuntimeInspector] onDidExecuteCommand not available in this VS Code build');
    }
  }

  public dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  // --------------------------------------------------------------------------
  // Text change observation
  // --------------------------------------------------------------------------

  private onTextChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }

    const timestamp = Date.now();
    const fileName = event.document.fileName;

    let insertedChars = 0;
    let insertedLines = 0;
    let deletedChars = 0;
    let previewSnippet = '';

    for (const change of event.contentChanges) {
      insertedChars += change.text.length;
      if (change.text.length > 0) {
        insertedLines += Math.max(1, change.text.split('\n').length - 1);
      }
      deletedChars += change.rangeLength;
      if (!previewSnippet && change.text.trim().length > 0) {
        previewSnippet = change.text.replace(/\s+/g, ' ').trim().slice(0, 120);
      }
    }

    const previousTimestamp = this.lastInsertionAtByFile.get(fileName) ?? timestamp - 1000;
    const deltaMs = Math.max(1, timestamp - previousTimestamp);
    this.lastInsertionAtByFile.set(fileName, timestamp);
    const insertionVelocity = (insertedChars / deltaMs) * 1000;

    this.recentChanges.push({ timestamp, fileName, insertedChars });
    this.pruneRecentChanges(timestamp);

    const observation = this.buildObservation({
      fileName,
      insertedChars,
      insertedLines,
      deletedChars,
      insertionTimestamp: timestamp,
      insertionVelocity,
      previewSnippet,
    });

    this.log.info(
      `[RuntimeInspector] change file=${fileName}` +
      ` insertedChars=${insertedChars}` +
      ` velocity=${insertionVelocity.toFixed(1)}chars/s` +
      ` probableAI=${String(observation.looksAiGenerated)}` +
      ` confidence=${observation.confidence.toFixed(2)}`
    );

    // Emit for debug panel context only — NOT consumed by TelemetryService
    this.bus.emit('runtime.observation', observation);
    const signal = this.classifySignal(observation);
    this.bus.emit('runtime.signal', signal);
  }

  // --------------------------------------------------------------------------
  // Command observation
  // --------------------------------------------------------------------------

  private onCommand(event: ExecutedCommandEvent): void {
    const isCopilotRelated = this.isCopilotCommand(event.command);
    this.log.info(
      `[RuntimeInspector] command=${event.command} copilot=${String(isCopilotRelated)}`
    );
    this.bus.emit('runtime.command', {
      command: event.command,
      timestamp: Date.now(),
      isCopilotRelated,
    });
  }

  // --------------------------------------------------------------------------
  // Observation building — HEURISTIC scoring
  // --------------------------------------------------------------------------

  private buildObservation(input: {
    fileName: string;
    insertedChars: number;
    insertedLines: number;
    deletedChars: number;
    insertionTimestamp: number;
    insertionVelocity: number;
    previewSnippet: string;
  }): RuntimeObservation {
    const burstEvents = this.recentChanges.filter(
      (c) => input.insertionTimestamp - c.timestamp <= 2500 && c.insertedChars >= 80
    ).length;

    const structuredScore = this.looksStructured(input.previewSnippet) ? 0.2 : 0;
    const largeInsertionScore =
      input.insertedLines > 10 || input.insertedChars > 500
        ? 0.45
        : input.insertedChars > 180
        ? 0.25
        : 0;
    const velocityScore = input.insertionVelocity > 300 ? 0.25 : 0;
    const burstScore = burstEvents >= 3 ? 0.15 : burstEvents >= 2 ? 0.08 : 0;

    const confidence = Math.min(1, structuredScore + largeInsertionScore + velocityScore + burstScore);

    return {
      fileName: input.fileName,
      insertedChars: input.insertedChars,
      insertedLines: input.insertedLines,
      deletedChars: input.deletedChars,
      insertionTimestamp: input.insertionTimestamp,
      insertionVelocity: input.insertionVelocity,
      looksAiGenerated: confidence >= 0.45,
      confidence,
      previewSnippet: input.previewSnippet,
    };
  }

  private classifySignal(obs: RuntimeObservation): RuntimeSignal {
    let type: RuntimeSignalType = 'probable_manual_typing';
    let confidence = obs.confidence;

    if (obs.deletedChars > 200 && obs.insertedChars < 20) {
      type = 'rapid_delete';
    } else if (obs.insertedChars > 500 || obs.insertedLines > 10) {
      type = obs.looksAiGenerated ? 'probable_ai_insertion' : 'large_diff';
    } else if (obs.looksAiGenerated) {
      type = 'probable_ai_insertion';
    }

    if (type === 'probable_manual_typing') {
      confidence = Math.max(0.1, 1 - obs.confidence);
    }

    return {
      type,
      confidence,
      source: 'runtime.inspector/textDocument',
      timestamp: obs.insertionTimestamp,
      metadata: {
        fileName: obs.fileName,
        insertedChars: obs.insertedChars,
        insertedLines: obs.insertedLines,
        deletedChars: obs.deletedChars,
        insertionVelocity: obs.insertionVelocity,
        preview: obs.previewSnippet,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private looksStructured(text: string): boolean {
    if (!text || text.length < 20) {
      return false;
    }
    return /^\s{2,}|[{};=>]/.test(text) && /\n/.test(text);
  }

  private isCopilotCommand(command: string): boolean {
    return (
      command.startsWith('github.copilot') ||
      command.startsWith('copilot') ||
      command.includes('Copilot') ||
      command.includes('inlineChat') ||
      command.includes('interactiveEditor')
    );
  }

  private pruneRecentChanges(now: number): void {
    const cutoff = now - 5000;
    while (this.recentChanges.length > 0 && (this.recentChanges[0]?.timestamp ?? 0) < cutoff) {
      this.recentChanges.shift();
    }
  }
}
