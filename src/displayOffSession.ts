export type DisplayOffPhase = 'idle' | 'starting' | 'active' | 'waking';
export type DisplayPowerStatus = { supported: boolean; isInternal: boolean; isOn: boolean };

type Dependencies = {
  getDisplayPower(): Promise<DisplayPowerStatus>;
  setDisplayPower(on: boolean): Promise<void>;
  setAwake(awake: boolean): Promise<void>;
  prepare?(): Promise<void>;
  startGuard(): Promise<string>;
  heartbeat(token: string): Promise<boolean>;
  stopGuard(token: string): Promise<boolean>;
  subscribeWake(wake: () => void): () => void;
  scheduleTick(tick: () => Promise<void>): () => void;
  onState(phase: DisplayOffPhase): void;
  onError(error: unknown): void;
  guardTimeoutMs?: number;
};

// One transient session owns its wake listeners, guard lease, and idle override.
export class DisplayOffSession {
  private phase: DisplayOffPhase = 'idle';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cancelRequested = false;
  private disposed = false;
  private disposalFinished = false;
  private awake = false;
  private displayAttempted = false;
  private guardToken: string | null = null;
  private releaseInput: (() => void) | null = null;
  private releaseTick: (() => void) | null = null;
  private tickingGeneration: number | null = null;
  private generation = 0;

  constructor(private readonly dependencies: Dependencies) {}

  private setPhase(phase: DisplayOffPhase) {
    this.phase = phase;
    this.dependencies.onState(phase);
  }

  private checkCancellation() {
    if (this.cancelRequested || this.disposed) throw new Error('Display-off activation cancelled');
  }

  private guardRequest<T>(request: Promise<T>, operation: string,
    onLateValue?: (value: T) => Promise<void>): Promise<T> {
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error(`${operation} timed out`));
      }, this.dependencies.guardTimeoutMs ?? 5000);
      const finish = () => {
        clearTimeout(timer);
      };
      // Late acquisitions still require cleanup. Backend leases have distinct
      // tokens, so this cannot release a later session's guard.
      void request.then(async value => {
        if (expired && onLateValue) await onLateValue(value);
        else if (!expired) resolve(value);
      }, error => {
        if (!expired) reject(error);
      }).catch(error => this.dependencies.onError(error)).finally(finish);
    });
  }

  private stopGuard(token: string) {
    return this.guardRequest(this.dependencies.stopGuard(token), 'Stop display wake guard');
  }

  private releaseWakeInput() {
    try { this.releaseInput?.(); } catch (error) { this.dependencies.onError(error); }
    this.releaseInput = null;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Display-off session is disposed'));
    if (this.startPromise) return this.startPromise;
    if (this.phase === 'active') return Promise.resolve();
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.phase !== 'idle') return this.stop().then(() => this.start());
    this.cancelRequested = false;
    this.generation++;
    this.setPhase('starting');
    this.startPromise = this.activate().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async activate() {
    try {
      const power = await this.dependencies.getDisplayPower();
      this.checkCancellation();
      if (!power.supported || !power.isInternal || !power.isOn) {
        throw new Error('An awake, supported internal display is required');
      }
      await this.dependencies.prepare?.();
      this.checkCancellation();
      this.awake = true;
      await this.dependencies.setAwake(true);
      this.checkCancellation();
      this.guardToken = await this.guardRequest(this.dependencies.startGuard(), 'Start display wake guard',
        async token => { await this.stopGuard(token); });
      this.checkCancellation();
      this.releaseInput = this.dependencies.subscribeWake(() => {
        void this.stop().catch(this.dependencies.onError);
      });
      this.checkCancellation();
      // Even a lost RPC response may have switched the display off.
      this.displayAttempted = true;
      await this.dependencies.setDisplayPower(false);
      this.checkCancellation();
      this.setPhase('active');
      this.releaseTick = this.dependencies.scheduleTick(() => this.tick());
    } catch (error) {
      await this.restore();
      throw error;
    }
  }

  private async tick() {
    const generation = this.generation;
    if (this.disposed || this.phase !== 'active' || this.tickingGeneration === generation) return;
    this.tickingGeneration = generation;
    const isCurrent = () => !this.disposed && this.phase === 'active' && this.generation === generation;
    try {
      const token = this.guardToken;
      const alive = token && await this.guardRequest(this.dependencies.heartbeat(token), 'Display wake guard heartbeat');
      if (!isCurrent()) return;
      if (!alive) {
        throw new Error('Display wake guard is unavailable');
      }
      const power = await this.dependencies.getDisplayPower();
      if (!isCurrent() || this.guardToken !== token) return;
      if (power.isOn) await this.stop();
    } catch (error) {
      if (!isCurrent()) return;
      try { await this.stop(); } finally { this.dependencies.onError(error); }
    } finally {
      if (this.tickingGeneration === generation) this.tickingGeneration = null;
    }
  }

  stop(): Promise<void> {
    this.cancelRequested = true;
    if (this.disposalFinished) return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      await this.restore();
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async restore() {
    if (this.phase === 'idle') return;
    this.setPhase('waking');
    this.releaseTick?.();
    this.releaseTick = null;
    let restoreError: unknown;
    let displayRestored = !this.displayAttempted;
    const acknowledgeWake = () => {
      displayRestored = true;
      this.releaseWakeInput();
    };
    // Start the independent Wayland path first: native service discovery may
    // synchronously occupy this turn. Neither wake waits for the other RPC.
    const guardWake = (async () => {
      const token = this.guardToken;
      if (!token) return;
      try {
        if (await this.stopGuard(token)) {
          acknowledgeWake();
          this.guardToken = null;
        }
        else restoreError = new Error('Display recovery was not acknowledged');
      } catch (error) { restoreError = error; }
    })();
    const nativeWake = (async () => {
      try {
        if (this.displayAttempted) {
          await this.dependencies.setDisplayPower(true);
          acknowledgeWake();
        }
      } catch (error) { restoreError = error; }
    })();
    // A late On or owned guard stop must settle before another Off can start.
    await Promise.all([guardWake, nativeWake]);
    if (displayRestored) this.guardToken = null;
    if (!displayRestored) {
      this.scheduleRecovery();
      throw restoreError ?? new Error('Display recovery failed');
    }
    this.displayAttempted = false;
    this.releaseWakeInput();
    try {
      if (this.awake) await this.dependencies.setAwake(false);
    } catch (error) {
      this.scheduleRecovery();
      throw error;
    }
    this.awake = false;
    this.setPhase('idle');
  }

  private scheduleRecovery() {
    // Unloaded instances must never wake a replacement instance's display.
    // The independent backend lease still supplies its last-resort wake.
    if (this.disposed) return;
    // Keep failed cleanup retryable without accepting a new off activation.
    this.releaseTick = this.dependencies.scheduleTick(async () => {
      try { await this.stop(); } catch (error) { this.dependencies.onError(error); }
    });
  }

  async dispose() {
    this.disposed = true;
    try {
      await this.stop();
    } finally {
      this.disposalFinished = true;
      this.releaseTick?.();
      this.releaseTick = null;
      this.releaseWakeInput();
    }
  }
}
