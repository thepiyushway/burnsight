import * as vscode from 'vscode';
import { OverlayPanel } from '../overlay/OverlayPanel';

export const OPEN_OVERLAY_COMMAND = 'burnsight.openOverlay';

export function registerOpenOverlayCommand(
  context: vscode.ExtensionContext,
  overlayPanel: OverlayPanel
): void {
  const disposable = vscode.commands.registerCommand(OPEN_OVERLAY_COMMAND, () => {
    overlayPanel.open();
  });

  context.subscriptions.push(disposable);
}
