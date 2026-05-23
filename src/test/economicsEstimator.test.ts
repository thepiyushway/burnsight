import * as assert from 'assert';
import { EconomicsEnricher } from '../services/economicsEnricher';
import { AIRequestEvent } from '../types/aiTelemetry';

suite('Economics Estimation', () => {
  const enricher = new EconomicsEnricher();

  function makeEvent(overrides: Partial<AIRequestEvent>): AIRequestEvent {
    return {
      timestamp: 1,
      provider: 'github-copilot',
      requestId: 'req-1',
      status: 'success',
      model: 'gpt-4o-mini-2024-07-18',
      modelChain: ['gpt-4o-mini-2024-07-18'],
      hasEscalation: false,
      escalationCount: 0,
      latencyMs: 900,
      feature: 'chat/edit',
      isRetry: false,
      retryCount: 0,
      rawLine: 'ccreq:req-1.copilotmd | success | gpt-4o-mini-2024-07-18 | 900ms | [chat/edit]',
      sourceFile: '/tmp/copilot.log',
      fileOffset: 10,
      ...overrides,
    };
  }

  test('codex estimate is more expensive than mini for same latency/workflow', () => {
    const mini = enricher.enrich(makeEvent({ requestId: 'mini-1', model: 'gpt-4o-mini-2024-07-18' }));
    const codex = enricher.enrich(makeEvent({ requestId: 'codex-1', model: 'gpt-5.3-codex' }));

    assert.strictEqual(codex.estimatedTotalTokens > mini.estimatedTotalTokens, true);
    assert.strictEqual(codex.estimatedCostUsd > mini.estimatedCostUsd, true);
  });

  test('retry request amplifies estimated spend', () => {
    const base = enricher.enrich(
      makeEvent({ requestId: 'base-1', feature: 'chat/edit', retryCount: 0, isRetry: false })
    );

    const retried = enricher.enrich(
      makeEvent({
        requestId: 'retry-1',
        feature: 'retry-manual',
        retryCount: 1,
        isRetry: true,
      })
    );

    assert.strictEqual(retried.retryAmplification > 1, true);
    assert.strictEqual(retried.estimatedCostUsd > base.estimatedCostUsd, true);
    assert.strictEqual(retried.retryAmplifiedCostUsd > 0, true);
  });
});
