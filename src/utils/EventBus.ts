import * as vscode from 'vscode';

type Listener<T> = (payload: T) => void;

export class EventBus<TEvents extends object> {
  private listeners = new Map<keyof TEvents, Set<Listener<TEvents[keyof TEvents]>>>();

  public on<K extends keyof TEvents>(
    eventName: K,
    listener: Listener<TEvents[K]>
  ): vscode.Disposable {
    const eventListeners =
      this.listeners.get(eventName) ?? new Set<Listener<TEvents[keyof TEvents]>>();

    eventListeners.add(listener as Listener<TEvents[keyof TEvents]>);
    this.listeners.set(eventName, eventListeners);

    return new vscode.Disposable(() => {
      const registered = this.listeners.get(eventName);
      if (!registered) {
        return;
      }

      registered.delete(listener as Listener<TEvents[keyof TEvents]>);
      if (registered.size === 0) {
        this.listeners.delete(eventName);
      }
    });
  }

  public emit<K extends keyof TEvents>(eventName: K, payload: TEvents[K]): void {
    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners) {
      return;
    }

    for (const listener of eventListeners) {
      listener(payload as TEvents[keyof TEvents]);
    }
  }
}
