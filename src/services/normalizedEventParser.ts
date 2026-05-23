import { AIRequestEvent } from '../types/aiTelemetry';

// Supports model chains ("gpt-5.4-mini -> gpt-5.3-codex") and variable feature tags.
const CANONICAL_LINE_REGEX =
  /ccreq:([a-z0-9]+)\.copilotmd\s*\|\s*(success|cancelled|error|failed|failure|[a-zA-Z_-]+)\s*\|\s*([^|]+?)\s*\|\s*(\d{2,6})ms\s*\|\s*\[([^\]]+)\]/i;

export class NormalizedEventParser {
  public parse(input: {
    rawLine: string;
    timestamp: number;
    sourceFile: string;
    fileOffset: number;
  }): AIRequestEvent | undefined {
    const match = CANONICAL_LINE_REGEX.exec(input.rawLine);
    if (!match) {
      return undefined;
    }

    const requestId = match[1];
    const statusRaw = match[2].toLowerCase();
    const modelChain = match[3].trim();
    const model = this.extractRoutedModel(modelChain);
    const latencyMs = Number.parseInt(match[4], 10);
    const feature = match[5].trim();

    const status =
      statusRaw === 'success'
        ? 'success'
        : statusRaw.includes('cancel')
          ? 'cancelled'
          : statusRaw.includes('error') || statusRaw.includes('fail')
            ? 'error'
            : statusRaw;

    return {
      timestamp: input.timestamp,
      provider: 'github-copilot',
      requestId,
      status,
      model,
      latencyMs,
      feature,
      rawLine: input.rawLine,
      sourceFile: input.sourceFile,
      fileOffset: input.fileOffset,
    };
  }

  public getRegex(): RegExp {
    return CANONICAL_LINE_REGEX;
  }

  private extractRoutedModel(modelChain: string): string {
    if (!modelChain.includes('->')) {
      return modelChain;
    }

    const parts = modelChain.split('->').map((part) => part.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? modelChain;
  }
}
