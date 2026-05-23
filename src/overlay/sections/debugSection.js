export function renderDebugSection(debug) {
  if (!debug) {
    return '';
  }

  return '<section class="debug-card">'
    + '<div class="debug-title">RUNTIME INSPECTOR</div>'
    + '<div class="debug-grid">'
    + debugRow('Last Signal', debug.lastSignalType)
    + debugRow('Confidence', debug.lastSignalConfidence)
    + debugRow('Probable AI Insert', debug.probableAiInsertion)
    + debugRow('Last Copilot Cmd', debug.lastCopilotCommand)
    + debugRow('Insert Velocity', debug.lastInsertionVelocity)
    + '</div>'
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
