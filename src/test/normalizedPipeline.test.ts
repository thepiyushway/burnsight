import * as assert from 'assert';
import { EventDeduper } from '../services/eventDeduper';
import { NormalizedEventParser } from '../services/normalizedEventParser';
import { SessionAggregator } from '../services/sessionAggregator';

suite('Normalized Telemetry Pipeline', () => {
  const parser = new NormalizedEventParser();

  test('parser handles success event', () => {
    const event = parser.parse({
      rawLine: 'ccreq:abc123.copilotmd | success | gpt-5.3-codex | 1420ms | [chat/edit]',
      timestamp: 1,
      sourceFile: '/tmp/copilot.log',
      fileOffset: 100,
    });

    assert.ok(event);
    assert.strictEqual(event?.requestId, 'abc123');
    assert.strictEqual(event?.status, 'success');
    assert.strictEqual(event?.model, 'gpt-5.3-codex');
    assert.strictEqual(event?.latencyMs, 1420);
    assert.strictEqual(event?.feature, 'chat/edit');
  });

  test('parser normalizes cancelled and retry feature', () => {
    const event = parser.parse({
      rawLine: 'ccreq:def456.copilotmd | cancelled | gpt-5.3-codex | 980ms | [retry-manual]',
      timestamp: 2,
      sourceFile: '/tmp/copilot.log',
      fileOffset: 110,
    });

    assert.ok(event);
    assert.strictEqual(event?.status, 'cancelled');
    assert.strictEqual(event?.feature, 'retry-manual');
  });

  test('parser resolves model chain to routed model', () => {
    const event = parser.parse({
      rawLine: 'ccreq:fedcba.copilotmd | success | gpt-5.4-mini -> gpt-5.3-codex | 2200ms | [agent/apply]',
      timestamp: 3,
      sourceFile: '/tmp/copilot.log',
      fileOffset: 120,
    });

    assert.ok(event);
    assert.strictEqual(event?.model, 'gpt-5.3-codex');
  });

  test('parser rejects malformed lines', () => {
    const event = parser.parse({
      rawLine: '[copilot] random unstructured line',
      timestamp: 4,
      sourceFile: '/tmp/copilot.log',
      fileOffset: 130,
    });

    assert.strictEqual(event, undefined);
  });

  test('deduper rejects duplicate request-source-offset events', () => {
    const deduper = new EventDeduper();
    const parsed = parser.parse({
      rawLine: 'ccreq:abc999.copilotmd | success | gpt-5.3-codex | 700ms | [chat/edit]',
      timestamp: 5,
      sourceFile: '/tmp/copilot.log',
      fileOffset: 200,
    });

    assert.ok(parsed);
    assert.strictEqual(deduper.shouldProcess(parsed!), true);
    assert.strictEqual(deduper.shouldProcess(parsed!), false);

    const shifted = { ...parsed!, fileOffset: 201 };
    assert.strictEqual(deduper.shouldProcess(shifted), true);
  });

  test('session aggregator computes counts, latency, model/workflow and retries', () => {
    const aggregator = new SessionAggregator();

    const m1 = aggregator.consume({
      timestamp: 1,
      provider: 'github-copilot',
      requestId: 'r1',
      status: 'success',
      model: 'gpt-5.3-codex',
      latencyMs: 1000,
      feature: 'chat/edit',
      rawLine: 'line1',
      sourceFile: '/tmp/copilot.log',
      fileOffset: 10,
      pricingAvailable: true,
      estimatedInputTokens: undefined,
      estimatedOutputTokens: undefined,
      estimatedCostUsd: undefined,
    });

    assert.strictEqual(m1.totalRequests, 1);
    assert.strictEqual(m1.successCount, 1);
    assert.strictEqual(m1.averageLatencyMs, 1000);
    assert.strictEqual(m1.requestsByModel['gpt-5.3-codex'], 1);
    assert.strictEqual(m1.requestsByFeature['chat/edit'], 1);

    const m2 = aggregator.consume({
      timestamp: 2,
      provider: 'github-copilot',
      requestId: 'r2',
      status: 'cancelled',
      model: 'gpt-5.3-codex',
      latencyMs: 500,
      feature: 'retry-manual',
      rawLine: 'line2',
      sourceFile: '/tmp/copilot.log',
      fileOffset: 20,
      pricingAvailable: false,
      estimatedInputTokens: undefined,
      estimatedOutputTokens: undefined,
      estimatedCostUsd: undefined,
    });

    assert.strictEqual(m2.totalRequests, 2);
    assert.strictEqual(m2.cancelledCount, 1);
    assert.strictEqual(m2.retryRequests, 1);
    assert.strictEqual(m2.totalLatencyMs, 1500);
    assert.strictEqual(m2.averageLatencyMs, 750);
  });
});
