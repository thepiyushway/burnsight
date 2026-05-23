import * as vscode from 'vscode';
import { BurnSightEvents } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';
import { getOverlayHtml } from './template';
import { createDashboardViewModelFromSession, DashboardViewModel } from './DashboardViewModel';

export class OverlayPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private ready = false;
  private readonly updateDebounceMs = 150;
  private updateTimer: NodeJS.Timeout | undefined;
  private pendingViewModel: DashboardViewModel | undefined;
  private lastSerializedPayload = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bus: EventBus<BurnSightEvents>,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.subscriptions.push(
      this.bus.on('session.updated', ({ session, runtime }) => {
        this.log.info('[STATE] session updated');
        this.publishDashboardUpdate(
          createDashboardViewModelFromSession(session, runtime)
        );
      })
    );
  }

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      if (this.ready) {
        this.flushDashboardUpdate();
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

    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
        if (message.type === 'dashboard:ready' && this.panel) {
          this.ready = true;
          this.log.info('[UI] active panel updated');
          if (this.pendingViewModel) {
            this.flushDashboardUpdate();
          }
        }
      })
    );

    this.log.info('[UI] webview message listener registered');
    this.panel.webview.html = getOverlayHtml(this.panel.webview, this.context.extensionUri);

    this.subscriptions.push(
      this.panel.onDidDispose(() => {
        this.ready = false;
        this.panel = undefined;
        if (this.updateTimer) {
          clearTimeout(this.updateTimer);
          this.updateTimer = undefined;
        }
        this.pendingViewModel = undefined;
        this.lastSerializedPayload = '';
      })
    );
  }

  private publishDashboardUpdate(viewModel: DashboardViewModel): void {
    this.log.info(
      `[VIEWMODEL] generated dashboard model requests=${viewModel.totalRequests} cost=${viewModel.estimatedSessionCostUsd.toFixed(2)} tokens=${viewModel.estimatedTotalTokens}`
    );
    this.pendingViewModel = viewModel;

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.flushDashboardUpdate();
    }, this.updateDebounceMs);
  }

  private flushDashboardUpdate(): void {
    if (!this.panel || !this.ready || !this.pendingViewModel) {
      return;
    }

    const payload = this.pendingViewModel;
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastSerializedPayload) {
      return;
    }

    this.lastSerializedPayload = serialized;
    this.log.info('[POSTMESSAGE] sending dashboard-update');
    this.log.info(`[UI] dashboard update pushed`);
    this.log.info(`[UI] payload size: ${Buffer.byteLength(serialized, 'utf8')} bytes`);

    void this.panel.webview.postMessage({
      type: 'dashboard-update',
      payload,
    });
  }

  public dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.panel?.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }
}
