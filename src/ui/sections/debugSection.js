export function renderDebugSection(debug) {
  if (!debug) {
    return '';
  }

  const recent = (debug.recentEvents || [])
    .map((line) => '<div class="debug-event">' + safeText(line) + '</div>')
    .join('');

  return '<section class="debug-card">'
    + '<div class="debug-title">RAW TELEMETRY DEBUG</div>'
    + '<div class="debug-grid">'
    + debugRow('Active Model', debug.activeModel)
    + debugRow('Request Count', debug.requestCount)
    + debugRow('Avg Latency', debug.avgLatencyMs)
    + debugRow('Last Runtime Signal', debug.lastRuntimeSignal)
    + debugRow('Signal Confidence', debug.lastRuntimeSignalConfidence)
    + debugRow('Last Copilot Cmd', debug.lastCopilotCommand)
    + debugRow('Last Event', debug.lastEventRaw)
    + '</div>'
    + '<div class="debug-events">' + recent + '</div>'
    + '</section>';
}

function debugRow(label, value) {
  return '<div class="debug-row">'
    + '<span class="debug-label">' + safeText(label) + '</span>'
    + '<span class="debug-value">' + safeText(value) + '</span>'
    + '</div>';
}

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}
