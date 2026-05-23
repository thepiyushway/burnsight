import * as vscode from 'vscode';
import { DashboardViewModel } from './DashboardViewModel';

function formatApproxCurrency(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return '~$0.00';
  }
  return `~$${value.toFixed(2)}`;
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return '0 tokens';
  }
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 1_000_000) {
    return `${(rounded / 1_000_000).toFixed(1)}m tokens`;
  }
  if (rounded >= 1_000) {
    return `${(rounded / 1_000).toFixed(1)}k tokens`;
  }
  return `${rounded} tokens`;
}

function formatDuration(ms: number | undefined): string {
  const totalSeconds = Math.floor(Math.max(0, ms ?? 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function getOverlayHtml(webview: vscode.Webview, extensionUri: vscode.Uri, initialViewModel?: DashboardViewModel): string {
  const stylesheetUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'styles.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'overlay.js')
  );

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const totalRequests = initialViewModel?.totalRequests ?? 0;
  const estimatedCost = initialViewModel?.estimatedSessionCostUsd ?? 0;
  const estimatedInputTokens = initialViewModel?.estimatedInputTokens ?? 0;
  const estimatedOutputTokens = initialViewModel?.estimatedOutputTokens ?? 0;
  const estimatedTotalTokens = initialViewModel?.estimatedTotalTokens ?? 0;
  const averageLatency = initialViewModel?.averageLatencyMs ?? 0;
  const retries = initialViewModel?.retries ?? 0;
  const escalations = initialViewModel?.escalations ?? 0;
  const activeModels = initialViewModel?.activeModels ?? [];
  const burnRate = initialViewModel?.estimatedBurnRateUsdPerHour ?? 0;
  const duration = initialViewModel?.sessionDurationMs ?? 0;
  const title = 'BURNSIGHT_RUNTIME_OBSERVABILITY';
  const version = initialViewModel?.version ?? 'v2.0.0-runtime';
  const runtimeLabel = initialViewModel?.runtimeLabel ?? 'IDLE';
  const activeModel = activeModels[activeModels.length - 1] ?? 'none';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BurnSight Overlay</title>
  <link rel="stylesheet" href="${stylesheetUri}" />
</head>
<body data-runtime-state="idle" data-debug="false">
  <div class="overlay" id="overlay-root">
    <div class="header">
      <div class="header-left">
        <span class="header-mark">[>]</span>
        <span class="header-title" id="title">${title}</span>
      </div>
      <div class="header-right">
        <span class="live-pill" id="live-pill"><span class="live-dot"></span><span id="runtime-label">${runtimeLabel}</span></span>
      </div>
    </div>

    <div class="body" id="cards">
      <section class="card" data-card-id="session">
        <div class="card-content">
          <div class="session-main">
            <div class="session-main-value" id="estimated-session-cost">${formatApproxCurrency(estimatedCost)}</div>
            <div class="session-subtitle">SESSION ESTIMATED SPEND</div>
          </div>
          <div class="progress-label">
            <span>SESSION BURN</span>
            <span class="accent-orange" id="estimated-burn-rate">${formatApproxCurrency(burnRate)}/hr</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" id="session-progress-fill" style="width:${Math.min(100, totalRequests)}%;"></div>
          </div>
          <div class="kv-grid">
            <div class="kv-item"><div class="kv-label">TOTAL REQUESTS</div><div class="kv-value accent-cyan" id="total-requests">${totalRequests}</div></div>
            <div class="kv-item"><div class="kv-label">EST. TOKENS</div><div class="kv-value accent-orange" id="estimated-total-tokens">${formatTokenCount(estimatedTotalTokens)}</div></div>
            <div class="kv-item"><div class="kv-label">EST. INPUT TOKENS</div><div class="kv-value" id="estimated-input-tokens">${formatTokenCount(estimatedInputTokens)}</div></div>
            <div class="kv-item"><div class="kv-label">EST. OUTPUT TOKENS</div><div class="kv-value" id="estimated-output-tokens">${formatTokenCount(estimatedOutputTokens)}</div></div>
            <div class="kv-item"><div class="kv-label">AVG LATENCY</div><div class="kv-value" id="average-latency-ms">${averageLatency > 0 ? `${Math.round(averageLatency)}ms` : '0ms'}</div></div>
            <div class="kv-item"><div class="kv-label">SESSION DURATION</div><div class="kv-value" id="session-duration">${formatDuration(duration)}</div></div>
            <div class="kv-item"><div class="kv-label">RETRIES</div><div class="kv-value accent-orange" id="retry-count">${retries}</div></div>
            <div class="kv-item"><div class="kv-label">ESCALATIONS</div><div class="kv-value accent-cyan" id="escalation-count">${escalations}</div></div>
          </div>
        </div>
      </section>

      <section class="card" data-card-id="models">
        <div class="card-header">MODEL ANALYTICS (REAL + ESTIMATED)</div>
        <div class="card-content">
          <div class="list-row"><span class="list-label">ACTIVE MODEL</span><span class="list-value" id="active-model">${activeModel}</span></div>
          <div class="list-row"><span class="list-label">ACTIVE MODELS</span><span class="list-value" id="active-models">${activeModels.join(', ') || 'none'}</span></div>
          <table class="table">
            <thead><tr><th>MODEL</th><th>REQS</th><th>EST. COST</th></tr></thead>
            <tbody id="model-spend-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card" data-card-id="workflows">
        <div class="card-header">WORKFLOW SPEND (ESTIMATED)</div>
        <div class="card-content">
          <table class="table">
            <thead><tr><th>WORKFLOW</th><th>REQS</th><th>EST. COST</th></tr></thead>
            <tbody id="workflow-spend-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card" data-card-id="insights">
        <div class="card-header">WORKFLOW INSIGHTS</div>
        <div class="card-content">
          <div class="list-row"><span class="list-label">MOST USED MODEL</span><span class="list-value" id="most-used-model">none</span></div>
          <div class="list-row"><span class="list-label">MOST EXPENSIVE MODEL</span><span class="list-value" id="most-expensive-model">none</span></div>
          <div class="list-row"><span class="list-label">TOP WORKFLOW</span><span class="list-value" id="top-workflow">none</span></div>
          <div class="list-row"><span class="list-label">RETRY COST SHARE</span><span class="list-value" id="retry-cost-share">0%</span></div>
          <div class="card-footer"><span>REQUEST DISTRIBUTION</span><span class="card-footer-value" id="request-distribution">none</span></div>
        </div>
      </section>

      <section class="card" data-card-id="lifecycle">
        <div class="card-header">REQUEST LIFECYCLE (REAL)</div>
        <div class="card-content">
          <div class="list-row"><span class="list-label">SESSION ARTIFACTS</span><span class="list-value" id="session-artifacts">0</span></div>
          <div class="list-row"><span class="list-label">AVG REQUEST COST</span><span class="list-value" id="average-request-cost">${formatApproxCurrency(totalRequests > 0 ? estimatedCost / totalRequests : 0)}</span></div>
        </div>
      </section>
    </div>

    <div class="debug-shell" id="debug-shell">
      <section class="debug-card">
        <div class="debug-title">RAW TELEMETRY DEBUG</div>
        <div class="debug-grid">
          <div class="debug-row"><span class="debug-label">Active Model</span><span class="debug-value" id="debug-active-model">none</span></div>
          <div class="debug-row"><span class="debug-label">Request Count</span><span class="debug-value" id="debug-request-count">0</span></div>
          <div class="debug-row"><span class="debug-label">Avg Latency</span><span class="debug-value" id="debug-avg-latency">0ms</span></div>
          <div class="debug-row"><span class="debug-label">Last Runtime Signal</span><span class="debug-value" id="debug-runtime-signal">none</span></div>
          <div class="debug-row"><span class="debug-label">Signal Confidence</span><span class="debug-value" id="debug-runtime-confidence">0%</span></div>
          <div class="debug-row"><span class="debug-label">Last Copilot Cmd</span><span class="debug-value" id="debug-last-command">none</span></div>
          <div class="debug-row"><span class="debug-label">Last Event</span><span class="debug-value" id="debug-last-event">none</span></div>
        </div>
        <div class="debug-events" id="debug-events"></div>
      </section>
    </div>

    <div class="footer-bar">
      <span id="version">${version}</span>
      <span class="footer-links">RUNTIME TELEMETRY</span>
    </div>
  </div>

  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
