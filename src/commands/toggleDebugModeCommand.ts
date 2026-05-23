import * as vscode from 'vscode';

export const TOGGLE_DEBUG_MODE_COMMAND = 'burnsight.toggleDebugMode';

export function registerToggleDebugModeCommand(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(TOGGLE_DEBUG_MODE_COMMAND, async () => {
    const config = vscode.workspace.getConfiguration('burnsight');
    const current = config.get<boolean>('debugTelemetry', false);
    const next = !current;

    await config.update('debugTelemetry', next, vscode.ConfigurationTarget.Global);
    const label = next ? 'enabled' : 'disabled';
    void vscode.window.showInformationMessage(`BurnSight debug mode ${label}`);
  });

  context.subscriptions.push(disposable);
}
