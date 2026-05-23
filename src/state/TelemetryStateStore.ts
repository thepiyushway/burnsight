import { TelemetryState } from '../telemetry/types';

/**
 * In-memory telemetry persistence for the extension host lifetime.
 */
export class TelemetryStateStore {
  private currentState: TelemetryState;

  constructor(initialState: TelemetryState) {
    this.currentState = initialState;
  }

  public get(): TelemetryState {
    return this.currentState;
  }

  public update(mutator: (previous: TelemetryState) => TelemetryState): TelemetryState {
    this.currentState = mutator(this.currentState);
    return this.currentState;
  }
}
