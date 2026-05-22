import * as vscode from 'vscode';
import {
  OPEN_OVERLAY_COMMAND,
  registerOpenOverlayCommand,
} from './commands/openOverlayCommand';
import { MetricRegistry, registerDefaultMetrics } from './metrics/MetricRegistry';
import { OverlayPanel } from './overlay/OverlayPanel';
import { FakeTelemetryProvider } from './providers/FakeTelemetryProvider';
import { SessionEngine } from './sessions/SessionEngine';
import { TelemetryEngine } from './telemetry/TelemetryEngine';
import { BurnSightEvents } from './telemetry/types';
import { EventBus } from './utils/EventBus';

export function activate(context: vscode.ExtensionContext) {
  const bus = new EventBus<BurnSightEvents>();
  const sessionEngine = new SessionEngine(bus);
  const metricRegistry = new MetricRegistry();
  registerDefaultMetrics(metricRegistry);
  const telemetryProvider = new FakeTelemetryProvider();

  const telemetryEngine = new TelemetryEngine({
    bus,
    sessionEngine,
    metricRegistry,
    telemetryProvider,
  });

  const overlayPanel = new OverlayPanel(context, telemetryEngine);

  registerOpenOverlayCommand(context, overlayPanel);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.text = '$(pulse) BurnSight';
  statusBarItem.tooltip = 'BurnSight: Open operational telemetry overlay';
  statusBarItem.command = OPEN_OVERLAY_COMMAND;

  statusBarItem.show();

  context.subscriptions.push(statusBarItem, telemetryEngine, overlayPanel);
}

export function deactivate() {}