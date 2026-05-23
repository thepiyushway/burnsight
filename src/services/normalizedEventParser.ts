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
    const modelChainParts = this.extractModelChain(modelChain);
    const model = this.extractRoutedModel(modelChain);
    const latencyMs = Number.parseInt(match[4], 10);
    const feature = match[5].trim();
    const retryCount = this.extractRetryCount(feature);

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
      modelChain: modelChainParts,
      routedFromModel: modelChainParts.length > 1 ? modelChainParts[modelChainParts.length - 2] : undefined,
      hasEscalation: modelChainParts.length > 1,
      escalationCount: Math.max(0, modelChainParts.length - 1),
      latencyMs,
      feature,
      isRetry: retryCount > 0,
      retryCount,
      rawLine: input.rawLine,
      sourceFile: input.sourceFile,
      fileOffset: input.fileOffset,
    };
  }

  public getRegex(): RegExp {
    return CANONICAL_LINE_REGEX;
  }

  private extractRoutedModel(modelChain: string): string {
    const parts = this.extractModelChain(modelChain);
    return parts[parts.length - 1] ?? modelChain;
  }

  private extractModelChain(modelChain: string): string[] {
    return modelChain.split('->').map((part) => part.trim()).filter(Boolean);
  }

  private extractRetryCount(feature: string): number {
    const normalized = feature.toLowerCase();
    if (!normalized.includes('retry')) {
      return 0;
    }

    const digitMatch = normalized.match(/retry[-_/ ]?(\d+)/i);
    if (!digitMatch) {
      return 1;
    }

    const parsed = Number.parseInt(digitMatch[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }
}
