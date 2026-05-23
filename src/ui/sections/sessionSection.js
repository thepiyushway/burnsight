export function renderSessionCard(card) {
  const rows = card.rows
    .map((row) => {
      const accent = row.accent ? 'accent-' + row.accent : '';
      return '<div class="kv-item">'
        + '<div class="kv-label">' + safeText(row.label) + '</div>'
        + '<div class="kv-value ' + accent + '">' + safeText(row.value) + '</div>'
        + '</div>';
    })
    .join('');

  return '<section class="card" data-card-id="' + safeText(card.id) + '">'
    + '<div class="card-content">'
    + '<div class="session-main">'
    + '<div class="session-main-value" data-animate="session-burn">' + safeText(card.mainValue) + '</div>'
    + '<div class="session-subtitle">' + safeText(card.title) + '</div>'
    + '</div>'
    + '<div class="progress-label">'
    + '<span>' + safeText(card.progressLabel) + '</span>'
    + '<span class="accent-orange" data-animate="context-remaining">' + safeText(card.progressValue) + '</span>'
    + '</div>'
    + '<div class="progress-track">'
    + '<div class="progress-fill" style="width:' + clampPercent(card.progressPct) + '%;"></div>'
    + '</div>'
    + '<div class="kv-grid">' + rows + '</div>'
    + '</div>'
    + '</section>';
}

function clampPercent(value) {
  const numeric = Number(value || 0);
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 100) {
    return 100;
  }
  return numeric;
}

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}
