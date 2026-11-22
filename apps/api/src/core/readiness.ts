/**
 * Readiness provider interface allowing dependency injection for deterministic testing.
 */
export interface ReadinessProvider {
  isReady(): Promise<boolean> | boolean;
  readonly isMock?: boolean;
}

/**
 * Mock readiness provider for offline development and unit/integration testing.
 */
export class MockReadinessProvider implements ReadinessProvider {
  public readonly isMock = true;

  constructor(private readyState: boolean = true) {}

  public isReady(): boolean {
    return this.readyState;
  }

  public setReady(ready: boolean): void {
    this.readyState = ready;
  }
}
