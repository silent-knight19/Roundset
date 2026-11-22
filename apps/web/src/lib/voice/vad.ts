import { MicVAD } from '@ricky0123/vad-web';

export type VADInstance = Awaited<ReturnType<typeof MicVAD.new>>;

export interface VADCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onVADMisfire?: () => void;
}

export interface VADAdapterOptions {
  baseAssetPath?: string;
  onnxWASMBasePath?: string;
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechMs?: number;
  redemptionMs?: number;
  preSpeechPadMs?: number;
}

export class VADAdapter {
  private detector: VADInstance | null = null;
  private detectorGeneration = 0;
  private currentGeneration = 0;
  private isInitializing = false;
  private isRunning = false;
  private callbacks: VADCallbacks = {};

  constructor(callbacks?: VADCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks;
    }
  }

  public setCallbacks(callbacks: VADCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async initialize(options?: VADAdapterOptions): Promise<boolean> {
    const sessionGeneration = ++this.currentGeneration;

    // Dispose any previous instance permanently before creating a new one
    if (this.detector) {
      const prev = this.detector;
      this.detector = null;
      this.detectorGeneration = 0;
      this.isRunning = false;
      try {
        await prev.destroy();
      } catch {
        // Safe disposal
      }
    }

    this.isInitializing = true;
    try {
      const detector = await MicVAD.new({
        model: 'v6',
        baseAssetPath:
          options?.baseAssetPath ||
          'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/',
        onnxWASMBasePath:
          options?.onnxWASMBasePath ||
          'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
        positiveSpeechThreshold: options?.positiveSpeechThreshold ?? 0.55,
        negativeSpeechThreshold: options?.negativeSpeechThreshold ?? 0.38,
        minSpeechMs: options?.minSpeechMs ?? 300,
        redemptionMs: options?.redemptionMs ?? 950,
        preSpeechPadMs: options?.preSpeechPadMs ?? 450,
        onSpeechStart: () => {
          if (this.isRunning && this.detectorGeneration === sessionGeneration) {
            this.callbacks.onSpeechStart?.();
          }
        },
        onSpeechEnd: () => {
          if (this.isRunning && this.detectorGeneration === sessionGeneration) {
            this.callbacks.onSpeechEnd?.();
          }
        },
        onVADMisfire: () => {
          if (this.detectorGeneration === sessionGeneration) {
            this.callbacks.onVADMisfire?.();
          }
        },
      });

      // Check if session became stale while waiting for MicVAD.new
      if (this.currentGeneration !== sessionGeneration) {
        try {
          await detector.destroy();
        } catch {
          // Safe disposal
        }
        return false;
      }

      this.detector = detector;
      this.detectorGeneration = sessionGeneration;
      return true;
    } catch (error) {
      if (this.currentGeneration === sessionGeneration) {
        this.detector = null;
        this.detectorGeneration = 0;
        this.isRunning = false;
        throw error;
      }
      return false;
    } finally {
      if (this.currentGeneration === sessionGeneration) {
        this.isInitializing = false;
      }
    }
  }

  public async start(generation?: number): Promise<boolean> {
    const targetGeneration = generation ?? this.detectorGeneration;
    if (!this.detector || (targetGeneration !== 0 && this.detectorGeneration !== targetGeneration)) {
      return false;
    }

    try {
      await this.detector.start();
      // Re-validate that ownership has not changed during asynchronous startup
      if (!this.detector || (targetGeneration !== 0 && this.detectorGeneration !== targetGeneration)) {
        return false;
      }
      this.isRunning = true;
      return true;
    } catch {
      this.isRunning = false;
      // If startup fails, destroy the failed detector to prevent audio context / mic resource leaks
      if (this.detector && (targetGeneration === 0 || this.detectorGeneration === targetGeneration)) {
        const failedInstance = this.detector;
        this.detector = null;
        this.detectorGeneration = 0;
        try {
          await failedInstance.destroy();
        } catch {
          // Safe disposal
        }
      }
      return false;
    }
  }

  public async pause(): Promise<void> {
    if (!this.detector) return;
    try {
      await this.detector.pause();
    } catch {
      // safe pause
    } finally {
      this.isRunning = false;
    }
  }

  public async destroy(generation?: number): Promise<void> {
    if (generation !== undefined) {
      // Scoped destruction: only dispose if active detector belongs to specified generation
      if (this.detector && this.detectorGeneration === generation) {
        const instance = this.detector;
        this.detector = null;
        this.detectorGeneration = 0;
        this.isRunning = false;
        try {
          await instance.destroy();
        } catch {
          // Safe disposal
        }
      }
      if (this.currentGeneration === generation) {
        ++this.currentGeneration;
        this.isInitializing = false;
      }
      return;
    }

    // Unscoped destruction: permanently dispose active detector and advance generation
    ++this.currentGeneration;
    this.isRunning = false;
    this.isInitializing = false;

    if (this.detector) {
      const instance = this.detector;
      this.detector = null;
      this.detectorGeneration = 0;
      try {
        await instance.destroy();
      } catch {
        // Safe disposal
      }
    }
  }

  public async cleanup(generation?: number): Promise<void> {
    await this.destroy(generation);
  }

  public getStatus(): {
    isRunning: boolean;
    isInitializing: boolean;
    hasInstance: boolean;
    generation: number;
    detectorGeneration: number;
  } {
    return {
      isRunning: this.isRunning,
      isInitializing: this.isInitializing,
      hasInstance: Boolean(this.detector),
      generation: this.currentGeneration,
      detectorGeneration: this.detectorGeneration,
    };
  }
}
