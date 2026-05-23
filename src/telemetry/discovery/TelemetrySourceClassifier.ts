import * as path from 'path';

export interface TelemetrySourceClassification {
  accepted: boolean;
  reason: string;
  matchedAllowTokens: string[];
  matchedSignatureTokens: string[];
  matchedDenyTokens: string[];
}

const ALLOW_PATH_TOKENS = [
  'github.copilot',
  'github.copilot-chat',
  'copilot',
  'copilotmd',
  'ccreq',
] as const;

const COPILOT_SIGNATURE_TOKENS = [
  'ccreq:',
  'copilotmd',
  'request done',
  'copilotlanguagemodelwrapper',
  'panel/editagent',
  'byok',
  'model deployment',
  'finish reason',
  'finishreason',
] as const;

const HARD_DENY_FILENAMES = new Set([
  'renderer.log',
  'main.log',
  'sharedprocess.log',
  'telemetry.log',
]);

const HARD_DENY_PATH_TOKENS = [
  'burnsight',
  'runtimeinspector',
  'extension-output',
  'output channels',
  'outputchannel',
] as const;

export class TelemetrySourceClassifier {
  public classify(filePath: string, sampleText: string): TelemetrySourceClassification {
    const lowerPath = filePath.toLowerCase();
    const basename = path.basename(lowerPath);
    const normalizedSample = sampleText.toLowerCase();

    const matchedAllowTokens = ALLOW_PATH_TOKENS.filter((token) => lowerPath.includes(token));
    const matchedSignatureTokens = COPILOT_SIGNATURE_TOKENS.filter((token) =>
      normalizedSample.includes(token)
    );
    const matchedDenyTokens = HARD_DENY_PATH_TOKENS.filter((token) => lowerPath.includes(token));

    if (matchedDenyTokens.length > 0) {
      return {
        accepted: false,
        reason: `hard-deny-path:${matchedDenyTokens.join(',')}`,
        matchedAllowTokens,
        matchedSignatureTokens,
        matchedDenyTokens,
      };
    }

    if (HARD_DENY_FILENAMES.has(basename) && matchedSignatureTokens.length === 0) {
      return {
        accepted: false,
        reason: `hard-deny-file:${basename}`,
        matchedAllowTokens,
        matchedSignatureTokens,
        matchedDenyTokens,
      };
    }

    if (matchedAllowTokens.length > 0) {
      return {
        accepted: true,
        reason: `allow-path:${matchedAllowTokens.join(',')}`,
        matchedAllowTokens,
        matchedSignatureTokens,
        matchedDenyTokens,
      };
    }

    if (matchedSignatureTokens.length > 0) {
      return {
        accepted: true,
        reason: `allow-signature:${matchedSignatureTokens.join(',')}`,
        matchedAllowTokens,
        matchedSignatureTokens,
        matchedDenyTokens,
      };
    }

    return {
      accepted: false,
      reason: 'no-copilot-allow-signals',
      matchedAllowTokens,
      matchedSignatureTokens,
      matchedDenyTokens,
    };
  }
}