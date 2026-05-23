import * as vscode from 'vscode';
import {
  OPEN_OVERLAY_COMMAND,
  registerOpenOverlayCommand,
} from './commands/openOverlayCommand';
import { MetricRegistry, registerDefaultMetrics } from './metrics/MetricRegistry';
import { OverlayPanel } from './overlay/OverlayPanel';
import { RuntimeTelemetryProvider } from './providers/RuntimeTelemetryProvider';
import { SessionEngine } from './sessions/SessionEngine';
import { RuntimeInspector } from './telemetry/RuntimeInspector';
import { TelemetryEngine } from './telemetry/TelemetryEngine';
import { BurnSightEvents, SessionState } from './telemetry/types';
import { EventBus } from './utils/EventBus';

export function activate(context: vscode.ExtensionContext) {
  const bus = new EventBus<BurnSightEvents>();
  const sessionEngine = new SessionEngine(bus);
  const runtimeInspector = new RuntimeInspector(bus);
  const metricRegistry = new MetricRegistry();
  registerDefaultMetrics(metricRegistry);
  const telemetryProvider = new RuntimeTelemetryProvider();

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

  statusBarItem.text = '◉ Idle';
  statusBarItem.tooltip = 'BurnSight: Open operational telemetry overlay';
  statusBarItem.command = OPEN_OVERLAY_COMMAND;

  const updateStatusBar = (): void => {
    const snapshot = telemetryEngine.getSnapshot();

    if (snapshot.runtimeState === SessionState.ACTIVE) {
      statusBarItem.text = `◉ ${snapshot.cards[0]?.kind === 'session' ? snapshot.cards[0].mainValue : '$0.00'}`;
      statusBarItem.tooltip = 'BurnSight: Active telemetry session';
      return;
    }

    if (snapshot.runtimeState === SessionState.BURST) {
      statusBarItem.text = `🔥 ${snapshot.cards[0]?.kind === 'session' ? snapshot.cards[0].mainValue : '$0.00'}`;
      statusBarItem.tooltip = 'BurnSight: Inference burst detected';
      return;
    }

    if (snapshot.runtimeState === SessionState.COOLING) {
      statusBarItem.text = '◉ Cooling';
      statusBarItem.tooltip = 'BurnSight: Runtime cooling down';
      return;
    }

    statusBarItem.text = '◉ Idle';
    statusBarItem.tooltip = 'BurnSight: Idle telemetry';
  };

  context.subscriptions.push(telemetryEngine.onSnapshot(updateStatusBar));
  updateStatusBar();

  statusBarItem.show();

  context.subscriptions.push(statusBarItem, runtimeInspector, telemetryEngine, overlayPanel);
}

export function deactivate() {}