import * as vscode from 'vscode';
import { BurnSightEvents } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';

export class SessionEngine implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly cadenceMs = 1000;

  constructor(private readonly bus: EventBus<BurnSightEvents>) {}

  public start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.bus.emit('session.tick', { elapsedMs: this.cadenceMs });
    }, this.cadenceMs);
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  public dispose(): void {
    this.stop();
  }
}
