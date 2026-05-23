import * as vscode from 'vscode';

export function getOverlayHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesheetUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'src', 'overlay', 'styles.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'src', 'overlay', 'overlay.js')
  );

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

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
        <span class="header-title" id="title">ECON_FORECAST_V1</span>
      </div>
      <div class="header-right">
        <span class="live-pill" id="live-pill"><span class="live-dot"></span><span id="runtime-label">IDLE</span></span>
        <span>CFG</span>
      </div>
    </div>

    <div class="body" id="cards"></div>

    <div class="debug-shell" id="debug-shell"></div>

    <div class="footer-bar">
      <span id="version">v0.8.2-BETA</span>
      <span class="footer-links">DOCS REPORTS</span>
    </div>
  </div>

  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
