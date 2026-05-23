import * as vscode from 'vscode';
import { BurnSightEvents } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';
import { TelemetryService } from '../telemetry/TelemetryService';
import { getOverlayHtml } from './template';

export class OverlayPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private ready = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly telemetryService: TelemetryService,
    private readonly bus: EventBus<BurnSightEvents>
  ) {
    this.subscriptions.push(
      this.bus.on('ui.webviewUpdate', (snapshot) => {
        if (!this.panel || !this.ready) {
          return;
        }

        void this.panel.webview.postMessage({
          type: 'overlay:update',
          payload: snapshot,
        });
      })
    );
  }

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      if (this.ready) {
        void this.panel.webview.postMessage({
          type: 'overlay:update',
          payload: this.telemetryService.getSnapshot(),
        });
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'burnsightOverlay',
      'BurnSight',
      {
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Beside,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'src', 'ui')],
      }
    );

    this.panel.webview.html = getOverlayHtml(this.panel.webview, this.context.extensionUri);

    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
        if (message.type === 'overlay:ready' && this.panel) {
          this.ready = true;
          void this.panel.webview.postMessage({
            type: 'overlay:update',
            payload: this.telemetryService.getSnapshot(),
          });
        }
      })
    );

    this.subscriptions.push(
      this.panel.onDidDispose(() => {
        this.ready = false;
        this.panel = undefined;
      })
    );
  }

  public dispose(): void {
    this.panel?.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}
