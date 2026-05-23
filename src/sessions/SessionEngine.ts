import * as vscode from 'vscode';
import { BurnSightEvents, RuntimeSignal, SessionState } from '../telemetry/types';
import { EventBus } from '../utils/EventBus';

export class SessionEngine implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly cadenceMs = 1000;
  private state: SessionState = SessionState.IDLE;
  private lastActivityAt = 0;
  private burstUntil = 0;
  private coolingUntil = 0;
  private readonly subscriptions: vscode.Disposable[] = [];

  private readonly burstSignalTypes = new Set<RuntimeSignal['type']>([
    'probable_ai_generation',
    'rewrite_burst',
    'apply_changes',
    'large_diff',
  ]);

  constructor(private readonly bus: EventBus<BurnSightEvents>) {
    this.subscriptions.push(
      this.bus.on('runtime.signal', (signal) => {
        this.consumeSignal(signal);
      })
    );
  }

  public start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.advanceStateMachine(Date.now());
      this.bus.emit('session.tick', { elapsedMs: this.cadenceMs, state: this.state });
    }, this.cadenceMs);

    this.bus.emit('session.stateChanged', {
      previous: SessionState.IDLE,
      current: this.state,
      reason: 'session-started',
    });
  }

  public getState(): SessionState {
    return this.state;
  }

  public triggerInteraction(reason = 'manual'): void {
    const now = Date.now();
    this.lastActivityAt = now;
    this.burstUntil = Math.max(this.burstUntil, now + 2000);
    this.transitionTo(SessionState.ACTIVE, reason);
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
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private consumeSignal(signal: RuntimeSignal): void {
    const now = Date.now();
    this.lastActivityAt = now;

    if (this.burstSignalTypes.has(signal.type)) {
      this.burstUntil = now + 2800;
      this.coolingUntil = this.burstUntil + 6000;
      this.transitionTo(SessionState.BURST, `signal:${signal.type}`);
      return;
    }

    if (this.state === SessionState.IDLE) {
      this.coolingUntil = now + 3500;
      this.transitionTo(SessionState.ACTIVE, `signal:${signal.type}`);
    }
  }

  private advanceStateMachine(now: number): void {
    if (this.state === SessionState.BURST && now >= this.burstUntil) {
      this.transitionTo(SessionState.COOLING, 'burst-window-ended');
      return;
    }

    if (this.state === SessionState.ACTIVE && now - this.lastActivityAt > 1400) {
      this.coolingUntil = now + 4500;
      this.transitionTo(SessionState.COOLING, 'activity-paused');
      return;
    }

    if (this.state === SessionState.COOLING && now >= this.coolingUntil) {
      this.transitionTo(SessionState.IDLE, 'cooled');
      return;
    }

    if (this.state === SessionState.IDLE && now - this.lastActivityAt < 900) {
      this.transitionTo(SessionState.ACTIVE, 'recent-activity');
    }
  }

  private transitionTo(next: SessionState, reason: string): void {
    if (this.state === next) {
      return;
    }

    const previous = this.state;
    this.state = next;

    this.bus.emit('session.stateChanged', {
      previous,
      current: next,
      reason,
    });
  }
}
