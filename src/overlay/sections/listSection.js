export function renderListCard(card) {
  const toneClass = card.tone === 'danger' ? 'list-card-danger' : '';

  const rows = card.rows
    .map((row) => {
      const accent = row.accent ? 'accent-' + row.accent : '';
      return '<div class="list-row">'
        + '<span class="list-label">' + safeText(row.label) + '</span>'
        + '<span class="list-value ' + accent + '">' + safeText(row.value) + '</span>'
        + '</div>';
    })
    .join('');

  const compactFooter = card.id === 'performance' ? 'compact' : '';
  const footer = card.footerLabel && card.footerValue
    ? '<div class="card-footer">'
        + '<span>' + safeText(card.footerLabel) + '</span>'
        + '<span class="card-footer-value ' + compactFooter + '">' + safeText(card.footerValue) + '</span>'
      + '</div>'
    : '';

  return '<section class="card ' + toneClass + '" data-card-id="' + safeText(card.id) + '">'
    + '<div class="card-header">' + safeText(card.title) + '</div>'
    + '<div class="card-content">'
    + rows
    + footer
    + '</div>'
    + '</section>';
}

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}
