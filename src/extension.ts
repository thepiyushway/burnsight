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
import { TelemetryService } from './services/TelemetryService';
import { BurnSightEvents, SessionState } from './telemetry/types';
import { OverlayPanel } from './ui/OverlayPanel';
import { EventBus } from './utils/EventBus';

export function activate(context: vscode.ExtensionContext) {
  const bus = new EventBus<BurnSightEvents>();
  const output = vscode.window.createOutputChannel('BurnSight Telemetry', { log: true });

  const telemetryService = TelemetryService.initialize(bus, output);
  const logParser = new CopilotLogParser(bus, output, context.logUri.fsPath, context.globalState);
  const runtimeInspector = new RuntimeInspector(bus, output);
  const overlayPanel = new OverlayPanel(context, bus, output);

  registerOpenOverlayCommand(context, overlayPanel);
  registerToggleDebugModeCommand(context);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    35
  );

  statusBarItem.text = '⚡ $0.00';
  statusBarItem.tooltip = 'BurnSight: Open operational telemetry overlay';
  statusBarItem.command = OPEN_OVERLAY_COMMAND;

  const updateStatusBar = (snapshot = telemetryService.getSnapshot()): void => {
    const sessionCard = snapshot.cards.find((card) => card.kind === 'session');
    const costValue = sessionCard?.kind === 'session' ? sessionCard.mainValue : '$0.00';
    const isHot = Number(costValue.replace(/[^0-9.]/g, '')) >= 1;
    const prefix = isHot ? '🔥' : '⚡';

    if (snapshot.runtimeState === SessionState.ACTIVE) {
      statusBarItem.text = `${prefix} ${costValue}`;
      statusBarItem.tooltip = 'BurnSight: Active telemetry (derived from Copilot runtime events)';
      return;
    }

    statusBarItem.text = `${prefix} ${costValue}`;
    statusBarItem.tooltip = 'BurnSight: Waiting for Copilot runtime telemetry';
  };

  context.subscriptions.push(
    bus.on('statusbar.update', (snapshot) => {
      updateStatusBar(snapshot);
    })
  );

  updateStatusBar();

  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    output,
    runtimeInspector,
    logParser,
    telemetryService,
    overlayPanel
  );
}

export function deactivate() {}