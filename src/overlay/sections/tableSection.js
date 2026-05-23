export function renderTableCard(card) {
  const head = card.columns.map((column) => '<th>' + safeText(column) + '</th>').join('');

  const rows = card.rows
    .map((row) => {
      const cells = row
        .map((cell, index) => {
          const accentClass = index === 0 ? '' : index === 2 ? 'accent-cyan' : '';
          return '<td class="' + accentClass + '">' + safeText(cell) + '</td>';
        })
        .join('');

      return '<tr>' + cells + '</tr>';
    })
    .join('');

  return '<section class="card" data-card-id="' + safeText(card.id) + '">'
    + '<div class="card-header">' + safeText(card.title) + '</div>'
    + '<table class="table">'
    + '<thead><tr>' + head + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>'
    + '</section>';
}

function safeText(value) {
  return value === undefined || value === null ? '' : String(value);
}
