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

export class RuntimeInspector implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('BurnSight Runtime Inspector');
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly lastInsertionAtByFile = new Map<string, number>();
  private readonly recentChanges: ChangeWindow[] = [];
  private lastCopilotCommand = 'none';

  constructor(private readonly bus: EventBus<BurnSightEvents>) {
    this.output.appendLine('[BurnSight] Runtime inspector initialized');

    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onDidChangeTextDocument(event))
    );

    const commandsWithEvent = vscode.commands as unknown as {
      onDidExecuteCommand?: vscode.Event<ExecutedCommandEvent>;
    };

    if (commandsWithEvent.onDidExecuteCommand) {
      this.subscriptions.push(
        commandsWithEvent.onDidExecuteCommand((event) => this.onDidExecuteCommand(event))
      );
    } else {
      this.log('command.execute', 'onDidExecuteCommand not available in this VS Code runtime');
    }

    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const fileName = editor?.document.fileName ?? 'none';
        this.log('editor.active', `file=${fileName}`);
      })
    );

    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const selectedChars = event.selections.reduce((sum, selection) => {
          if (selection.isEmpty) {
            return sum;
          }
          return sum + event.textEditor.document.getText(selection).length;
        }, 0);

        this.log(
          'editor.selection',
          `file=${event.textEditor.document.fileName} selections=${event.selections.length} selectedChars=${selectedChars}`
        );
      })
    );

    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.log('document.save', `file=${document.fileName} lines=${document.lineCount}`);
      })
    );
  }

  public dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.output.dispose();
  }

  private onDidExecuteCommand(event: ExecutedCommandEvent): void {
    const command = event.command;
    const timestamp = Date.now();
    const isCopilotRelated = this.isCopilotCommand(command);

    if (isCopilotRelated) {
      this.lastCopilotCommand = command;
    }

    this.log(
      'command.execute',
      `command=${command} args=${this.summarizeArgs(event.arguments)} copilot=${String(isCopilotRelated)}`
    );

    this.bus.emit('runtime.command', {
      command,
      timestamp,
      isCopilotRelated,
    });

    if (isCopilotRelated && this.isApplyCommand(command)) {
      this.bus.emit('runtime.signal', {
        type: 'apply_changes',
        confidence: 0.92,
        source: 'commands.onDidExecuteCommand',
        timestamp,
        metadata: { command },
      });
    }
  }

  private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }

    const insertionTimestamp = Date.now();
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

    const previousTimestamp = this.lastInsertionAtByFile.get(fileName) ?? insertionTimestamp - 1000;
    const deltaMs = Math.max(1, insertionTimestamp - previousTimestamp);
    this.lastInsertionAtByFile.set(fileName, insertionTimestamp);

    const insertionVelocity = (insertedChars / deltaMs) * 1000;

    this.recentChanges.push({
      timestamp: insertionTimestamp,
      fileName,
      insertedChars,
    });
    this.pruneRecentChanges(insertionTimestamp);

    const observation = this.buildObservation({
      fileName,
      insertedChars,
      insertedLines,
      deletedChars,
      insertionTimestamp,
      insertionVelocity,
      previewSnippet,
    });

    this.log(
      'document.change',
      [
        `file=${observation.fileName}`,
        `insertedChars=${observation.insertedChars}`,
        `insertedLines=${observation.insertedLines}`,
        `timestamp=${observation.insertionTimestamp}`,
        `velocity=${observation.insertionVelocity.toFixed(1)} chars/s`,
        `probableAI=${String(observation.looksAiGenerated)}`,
        `confidence=${observation.confidence.toFixed(2)}`,
        `preview="${observation.previewSnippet}"`,
      ].join(' ')
    );

    this.bus.emit('runtime.observation', observation);

    const signal = this.classifySignal(observation);
    this.bus.emit('runtime.signal', signal);
  }

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
      (change) => input.insertionTimestamp - change.timestamp <= 2500 && change.insertedChars >= 80
    ).length;

    const structuredScore = this.looksStructured(input.previewSnippet) ? 0.2 : 0;
    const largeInsertionScore =
      input.insertedLines > 10 || input.insertedChars > 500
        ? 0.45
        : input.insertedChars > 180
        ? 0.25
        : 0;
    const velocityScore =
      input.insertionVelocity > 1500
        ? 0.3
        : input.insertionVelocity > 600
        ? 0.16
        : 0;
    const burstScore = burstEvents >= 3 ? 0.25 : 0;

    const confidence = Math.min(0.98, largeInsertionScore + velocityScore + structuredScore + burstScore);

    return {
      fileName: input.fileName,
      insertedChars: input.insertedChars,
      insertedLines: input.insertedLines,
      deletedChars: input.deletedChars,
      insertionTimestamp: input.insertionTimestamp,
      insertionVelocity: input.insertionVelocity,
      looksAiGenerated: confidence >= 0.55,
      confidence,
      previewSnippet: input.previewSnippet || '',
    };
  }

  private classifySignal(observation: RuntimeObservation): RuntimeSignal {
    const timestamp = observation.insertionTimestamp;
    const burstEvents = this.recentChanges.filter(
      (change) => timestamp - change.timestamp <= 2500 && change.insertedChars >= 80
    ).length;

    if (observation.deletedChars > 250 && observation.insertedChars < 20) {
      return this.createSignal('rapid_delete', Math.min(0.9, 0.55 + observation.deletedChars / 1200), {
        fileName: observation.fileName,
        deletedChars: observation.deletedChars,
      });
    }

    if (observation.insertedLines > 60 || observation.insertedChars > 2500) {
      return this.createSignal('large_diff', 0.9, {
        fileName: observation.fileName,
        insertedChars: observation.insertedChars,
        insertedLines: observation.insertedLines,
        insertionVelocity: observation.insertionVelocity,
        preview: observation.previewSnippet,
      });
    }

    if (burstEvents >= 3 && observation.insertedChars >= 120) {
      return this.createSignal('rewrite_burst', Math.min(0.95, 0.6 + burstEvents * 0.08), {
        fileName: observation.fileName,
        insertedChars: observation.insertedChars,
        insertedLines: observation.insertedLines,
        insertionVelocity: observation.insertionVelocity,
        preview: observation.previewSnippet,
      });
    }

    if (observation.looksAiGenerated) {
      return this.createSignal('probable_ai_generation', observation.confidence, {
        fileName: observation.fileName,
        insertedChars: observation.insertedChars,
        insertedLines: observation.insertedLines,
        insertionVelocity: observation.insertionVelocity,
        preview: observation.previewSnippet,
      });
    }

    return this.createSignal(
      'probable_manual_typing',
      Math.min(0.9, 0.55 + Math.max(0, 200 - observation.insertedChars) / 500),
      {
        fileName: observation.fileName,
        insertedChars: observation.insertedChars,
        insertedLines: observation.insertedLines,
        insertionVelocity: observation.insertionVelocity,
        preview: observation.previewSnippet,
      }
    );
  }

  private createSignal(
    type: RuntimeSignalType,
    confidence: number,
    metadata: RuntimeSignal['metadata']
  ): RuntimeSignal {
    const signal: RuntimeSignal = {
      type,
      confidence: Math.max(0, Math.min(1, confidence)),
      source: 'runtime-inspector',
      timestamp: Date.now(),
      metadata,
    };

    this.log(
      'signal.classified',
      `type=${signal.type} confidence=${signal.confidence.toFixed(2)} file=${metadata?.fileName ?? 'n/a'} command=${metadata?.command ?? 'n/a'}`
    );

    return signal;
  }

  private isCopilotCommand(command: string): boolean {
    const lower = command.toLowerCase();
    return (
      lower.startsWith('github.copilot')
      || lower.includes('copilot.chat')
      || lower.includes('copilot')
    );
  }

  private isApplyCommand(command: string): boolean {
    const lower = command.toLowerCase();
    return lower.includes('apply') || lower.includes('fix') || lower.includes('insert');
  }

  private looksStructured(preview: string): boolean {
    return /(function|class|interface|import\s|const\s|let\s|=>|return\s|if\s*\(|for\s*\()/i.test(preview);
  }

  private summarizeArgs(args: unknown[] | undefined): string {
    if (!args || args.length === 0) {
      return '[]';
    }

    const preview = args
      .slice(0, 3)
      .map((arg) => {
        if (arg === null || arg === undefined) {
          return String(arg);
        }

        if (typeof arg === 'string') {
          return arg.length > 40 ? `${arg.slice(0, 40)}...` : arg;
        }

        if (typeof arg === 'number' || typeof arg === 'boolean') {
          return String(arg);
        }

        return '{...}';
      })
      .join(', ');

    return `[${preview}${args.length > 3 ? ', ...' : ''}]`;
  }

  private pruneRecentChanges(now: number): void {
    const threshold = now - 5000;
    while (this.recentChanges.length > 0 && this.recentChanges[0].timestamp < threshold) {
      this.recentChanges.shift();
    }
  }

  private log(scope: string, message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${scope}: ${message}`);
  }
}
