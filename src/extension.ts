import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.text = '🧠 $0.00';
  statusBarItem.tooltip = 'BurnSight';
  statusBarItem.command = 'burnsight.openOverlay';

  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

export function deactivate() {}