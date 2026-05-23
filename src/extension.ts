import * as vscode from 'vscode';
import {
  OPEN_OVERLAY_COMMAND,
  registerOpenOverlayCommand,
} from './commands/openOverlayCommand';
import {
  registerToggleDebugModeCommand,
} from './commands/toggleDebugModeCommand';
import { CopilotLogParser } from './parsers/CopilotLogParser';
import { RuntimeInspector } from './telemetry/RuntimeInspector';
import { TelemetryService } from './telemetry/TelemetryService';
import { BurnSightEvents } from './telemetry/types';
import { OverlayPanel } from './ui/OverlayPanel';
import { EventBus } from './utils/EventBus';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('BurnSight Telemetry', { log: true });
  output.info('[BOOT] BurnSight activating — extensionLogPath=' + context.logUri.fsPath);

  const bus = new EventBus<BurnSightEvents>();
  output.info('[BOOT] EventBus created');

  const telemetryService = TelemetryService.initialize(bus, output, context);
  output.info('[BOOT] TelemetryService initialized — singleton id=' + (TelemetryService as unknown as { instance?: unknown }).instance?.constructor?.name);

  const logParser = new CopilotLogParser(bus, output, context.logUri.fsPath, context.globalState);
  output.info('[BOOT] CopilotLogParser created');

  const runtimeInspector = new RuntimeInspector(bus, output);
  output.info('[BOOT] RuntimeInspector created');

  const overlayPanel = new OverlayPanel(context, bus, output);
  output.info('[BOOT] OverlayPanel created');

  registerOpenOverlayCommand(context, overlayPanel);
  registerToggleDebugModeCommand(context);
  output.info('[BOOT] Commands registered');

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    35
  );

  statusBarItem.text = '⚡ $0.00';
  statusBarItem.tooltip = 'BurnSight: Open operational telemetry overlay';
  statusBarItem.command = OPEN_OVERLAY_COMMAND;

  context.subscriptions.push(
    bus.on('statusbar.update', ({ estimatedTotalCostUsd, isActive }) => {
      const costValue = estimatedTotalCostUsd > 0
        ? `$${estimatedTotalCostUsd.toFixed(estimatedTotalCostUsd >= 0.01 ? 2 : 4)}`
        : '$0.00';
      const isHot = estimatedTotalCostUsd >= 1;
      statusBarItem.text = `${isHot ? '🔥' : '⚡'} ${costValue}`;
      statusBarItem.tooltip = isActive
        ? 'BurnSight: Active telemetry'
        : 'BurnSight: Waiting for Copilot telemetry';
    })
  );

  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    output,
    runtimeInspector,
    logParser,
    telemetryService,
    overlayPanel
  );

  output.info('[BOOT] Activation complete — all components registered');
}
export function deactivate() {}