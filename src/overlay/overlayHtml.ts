import * as vscode from 'vscode';

export function getOverlayHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const _unused = extensionUri;
  void _unused;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BurnSight Overlay</title>
  <style>
    :root {
      --bg: #05070a;
      --panel: #090d12;
      --panel-2: #0a1016;
      --line: #1d2833;
      --line-hard: #233341;
      --text: #c6d2de;
      --text-dim: #7c8994;
      --cyan: #11d6ff;
      --green: #09f78b;
      --orange: #ffb56a;
      --red-bg: #16090b;
      --red-line: #3f1a20;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 12px;
      background:
        radial-gradient(circle at 12% 0%, rgba(17, 214, 255, 0.08), transparent 40%),
        linear-gradient(180deg, #04060a 0%, #070b10 100%);
      color: var(--text);
      font-family: 'IBM Plex Mono', 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
      letter-spacing: 0.01em;
    }

    .overlay {
      width: min(380px, 100%);
      border: 1px solid var(--line-hard);
      background: linear-gradient(180deg, #070b10 0%, #06090d 100%);
      box-shadow:
        inset 0 0 0 1px rgba(17, 214, 255, 0.05),
        0 14px 40px rgba(0, 0, 0, 0.45);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #060b10 0%, #070d14 100%);
      min-height: 34px;
    }

    .header-left {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .header-mark {
      color: var(--cyan);
      font-size: 10px;
    }

    .header-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--cyan);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-right {
      display: flex;
      gap: 10px;
      align-items: center;
      font-size: 11px;
    }

    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(9, 247, 139, 0.25);
      color: var(--green);
      background: rgba(9, 247, 139, 0.08);
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 1.3s infinite;
    }

    @keyframes pulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }

    .body {
      padding: 8px;
      display: grid;
      gap: 10px;
    }

    .card {
      border: 1px solid var(--line-hard);
      background: linear-gradient(180deg, #070b11 0%, #05090e 100%);
      position: relative;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 7px;
      border-bottom: 1px solid var(--line);
      color: #a8b4c0;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 10px;
      font-weight: 700;
    }

    .card-content {
      padding: 10px;
    }

    .session-main {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .session-main-value {
      font-size: 39px;
      line-height: 1;
      color: var(--cyan);
      font-weight: 700;
    }

    .session-subtitle {
      font-size: 11px;
      color: #9ba6b3;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }

    .progress-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 5px;
      font-size: 11px;
      color: #9eacb9;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }

    .progress-track {
      height: 7px;
      border: 1px solid var(--line-hard);
      background: #111820;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #ffd0b0 0%, #ffa37f 40%, #ef8d73 100%);
      transition: width 400ms ease;
    }

    .kv-grid {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .kv-item {
      display: grid;
      gap: 3px;
    }

    .kv-label {
      font-size: 10px;
      text-transform: uppercase;
      color: #8d99a5;
      letter-spacing: 0.06em;
      font-weight: 600;
    }

    .kv-value {
      font-size: 21px;
      color: #ecf3fb;
      font-weight: 700;
    }

    .accent-green {
      color: var(--green);
    }

    .accent-cyan {
      color: var(--cyan);
    }

    .accent-orange {
      color: var(--orange);
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .table thead th {
      text-align: left;
      font-weight: 600;
      color: #90a0af;
      padding: 8px 9px;
      border-bottom: 1px solid var(--line);
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.05em;
    }

    .table thead th + th,
    .table tbody td + td {
      border-left: 1px solid #12202d;
    }

    .table tbody td {
      padding: 8px 9px;
      border-bottom: 1px solid var(--line);
      color: #d2dbe4;
      font-weight: 600;
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    .table td:nth-child(2),
    .table td:nth-child(3),
    .table th:nth-child(2),
    .table th:nth-child(3) {
      text-align: right;
    }

    .list-card-danger {
      border-color: var(--red-line);
      background: linear-gradient(180deg, #13090c 0%, #10080a 100%);
    }

    .list-card-danger .card-header {
      border-bottom-color: var(--red-line);
    }

    .list-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(58, 81, 98, 0.35);
      font-size: 12px;
    }

    .list-row:last-child {
      border-bottom: none;
    }

    .list-label {
      color: #ccd6e0;
      font-weight: 600;
    }

    .list-value {
      color: #f0f6ff;
      font-weight: 700;
    }

    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8896a2;
      font-weight: 700;
    }

    .card-footer-value {
      font-size: 29px;
      color: #ecf3fb;
      line-height: 1;
      letter-spacing: 0;
    }

    .card-footer-value.compact {
      font-size: 22px;
      color: var(--cyan);
    }

    .footer-bar {
      border-top: 1px solid var(--line);
      padding: 8px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #73808a;
    }

    .footer-links {
      display: flex;
      gap: 14px;
      color: #a8b4bf;
      font-weight: 600;
    }

    @media (max-width: 420px) {
      body { padding: 8px; }
      .overlay { width: 100%; }
      .session-main-value { font-size: 33px; }
      .card-footer-value { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="overlay" id="overlay-root">
    <div class="header">
      <div class="header-left">
        <span class="header-mark">[>]</span>
        <span class="header-title" id="title">ECON_FORECAST_V1</span>
      </div>
      <div class="header-right">
        <span class="live-pill"><span class="live-dot"></span>LIVE</span>
        <span>CFG</span>
      </div>
    </div>
    <div class="body" id="cards"></div>
    <div class="footer-bar">
      <span id="version">v0.8.2-BETA</span>
      <span class="footer-links">DOCS REPORTS</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const cardsRoot = document.getElementById('cards');
    const titleEl = document.getElementById('title');
    const versionEl = document.getElementById('version');

    function safeText(value) {
      return value === undefined || value === null ? '' : String(value);
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

    function renderSessionCard(card) {
      const rows = card.rows.map((row) => {
        const accent = row.accent ? 'accent-' + row.accent : '';
        return '<div class="kv-item">'
          + '<div class="kv-label">' + safeText(row.label) + '</div>'
          + '<div class="kv-value ' + accent + '">' + safeText(row.value) + '</div>'
          + '</div>';
      }).join('');

      return '<section class="card" data-card-id="' + safeText(card.id) + '">'
        + '<div class="card-content">'
        + '<div class="session-main">'
        + '<div class="session-main-value">' + safeText(card.mainValue) + '</div>'
        + '<div class="session-subtitle">' + safeText(card.title) + '</div>'
        + '</div>'
        + '<div class="progress-label">'
        + '<span>' + safeText(card.progressLabel) + '</span>'
        + '<span class="accent-orange">' + safeText(card.progressValue) + '</span>'
        + '</div>'
        + '<div class="progress-track">'
        + '<div class="progress-fill" style="width:' + clampPercent(card.progressPct) + '%;"></div>'
        + '</div>'
        + '<div class="kv-grid">' + rows + '</div>'
        + '</div>'
        + '</section>';
    }

    function renderTableCard(card) {
      const head = card.columns.map((column) => '<th>' + safeText(column) + '</th>').join('');
      const rows = card.rows.map((row) => {
        const cells = row.map((cell, index) => {
          const accentClass = index === 0 ? '' : (index === 2 ? 'accent-cyan' : '');
          return '<td class="' + accentClass + '">' + safeText(cell) + '</td>';
        }).join('');
        return '<tr>' + cells + '</tr>';
      }).join('');

      return '<section class="card" data-card-id="' + safeText(card.id) + '">'
        + '<div class="card-header">' + safeText(card.title) + '</div>'
        + '<table class="table">'
        + '<thead><tr>' + head + '</tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table>'
        + '</section>';
    }

    function renderListCard(card) {
      const toneClass = card.tone === 'danger' ? 'list-card-danger' : '';
      const rows = card.rows.map((row) => {
        const accent = row.accent ? 'accent-' + row.accent : '';
        return '<div class="list-row">'
          + '<span class="list-label">' + safeText(row.label) + '</span>'
          + '<span class="list-value ' + accent + '">' + safeText(row.value) + '</span>'
          + '</div>';
      }).join('');

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

    function renderSnapshot(snapshot) {
      if (!snapshot) {
        return;
      }

      titleEl.textContent = safeText(snapshot.title);
      versionEl.textContent = safeText(snapshot.version);

      const html = (snapshot.cards || []).map((card) => {
        if (card.kind === 'session') {
          return renderSessionCard(card);
        }
        if (card.kind === 'table') {
          return renderTableCard(card);
        }
        return renderListCard(card);
      }).join('');

      cardsRoot.innerHTML = html;
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'overlay:update') {
        return;
      }

      renderSnapshot(message.payload);
    });

    vscode.postMessage({ type: 'overlay:ready' });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}
