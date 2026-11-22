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
    if (this.isInitializing) return false;
    this.cleanup();

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
          if (this.isRunning) {
            this.callbacks.onSpeechStart?.();
          }
        },
        onSpeechEnd: () => {
          if (this.isRunning) {
            this.callbacks.onSpeechEnd?.();
          }
        },
        onVADMisfire: () => {
          this.callbacks.onVADMisfire?.();
        },
      });

      this.detector = detector;
      return true;
    } catch (error) {
      this.cleanup();
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  public start(): void {
    if (!this.detector) return;
    try {
      this.detector.start();
      this.isRunning = true;
    } catch {
      this.isRunning = false;
    }
  }

  public pause(): void {
    if (!this.detector) return;
    try {
      this.detector.pause();
    } catch {
      // noop
    } finally {
      this.isRunning = false;
    }
  }

  public cleanup(): void {
    this.pause();
    if (this.detector) {
      try {
        this.detector.pause();
      } catch {
        // noop
      }
      this.detector = null;
    }
    this.isRunning = false;
    this.isInitializing = false;
  }

  public getStatus(): { isRunning: boolean; isInitializing: boolean; hasInstance: boolean } {
    return {
      isRunning: this.isRunning,
      isInitializing: this.isInitializing,
      hasInstance: Boolean(this.detector),
    };
  }
}
