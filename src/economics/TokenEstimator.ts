import { AIRequestEvent } from '../types/aiTelemetry';
import { resolveModelProfile } from './ModelProfiles';
import { resolveWorkflowWeight } from './WorkflowWeights';

export interface TokenEstimateResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  retryAmplification: number;
  escalationAmplification: number;
  orchestrationAmplification: number;
}

export class TokenEstimator {
  public estimate(event: AIRequestEvent): TokenEstimateResult {
    const modelProfile = resolveModelProfile(event.model);
    const workflowWeight = resolveWorkflowWeight(event.feature);

    const latencySeconds = Math.max(0.15, event.latencyMs / 1000);
    const observedChars = Math.max(32, event.rawLine.length);

    const retryCount = Math.max(0, event.retryCount ?? (event.isRetry ? 1 : 0));
    const escalationCount = Math.max(0, event.escalationCount ?? 0);

    const baseCharTokens = observedChars / 4;
    const throughputTokens =
      latencySeconds * modelProfile.avgTokensPerSecond * modelProfile.reasoningMultiplier;

    const statusOutputFactor = event.status === 'success' ? 1 : 0.62;

    const orchestrationAmplification =
      modelProfile.orchestrationMultiplier * workflowWeight.orchestrationMultiplier;
    const retryAmplification = 1 + retryCount * workflowWeight.retryPenalty;
    const escalationAmplification = 1 + escalationCount * 0.35;

    const outputTokens = Math.max(
      1,
      Math.round(
        Math.max(baseCharTokens * 1.1, throughputTokens) *
          workflowWeight.outputMultiplier *
          modelProfile.outputBias *
          statusOutputFactor *
          retryAmplification *
          escalationAmplification
      )
    );

    const inputTokens = Math.max(
      1,
      Math.round(
        Math.max(baseCharTokens * 2.6, outputTokens * 0.7) *
          workflowWeight.inputMultiplier *
          orchestrationAmplification *
          retryAmplification *
          escalationAmplification
      )
    );

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      retryAmplification,
      escalationAmplification,
      orchestrationAmplification,
    };
  }
}