export interface SpeechRecognitionResultItem {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  0: SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
}

export interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionTranscript {
  final: string;
  interim: string;
  display: string;
}

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
}

export function createBrowserSpeechRecognition(options?: {
  lang?: string;
}): BrowserSpeechRecognition | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  const Constructor = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (!Constructor) return null;

  try {
    const recognizer = new Constructor();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = options?.lang || 'en-IN';
    return recognizer;
  } catch {
    return null;
  }
}

export function combineRecognitionResults(
  results: ArrayLike<SpeechRecognitionResultLike>,
): RecognitionTranscript {
  let final = '';
  let interim = '';

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) continue;
    const text = result[0]?.transcript?.trim() || '';
    if (!text) continue;

    if (result.isFinal) {
      final += (final ? ' ' : '') + text;
    } else {
      interim += (interim ? ' ' : '') + text;
    }
  }

  const display = [final, interim].filter(Boolean).join(' ').trim();
  return { final, interim, display };
}

export interface VoiceRecognitionCallbacks {
  onTranscript?: (transcript: RecognitionTranscript) => void;
  onError?: (error: string, isPermissionDenied: boolean) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

export class VoiceRecognitionAdapter {
  private recognition: BrowserSpeechRecognition | null = null;
  private isBusy = false;
  private isWanted = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: VoiceRecognitionCallbacks = {};

  constructor(callbacks?: VoiceRecognitionCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks;
    }
  }

  public setCallbacks(callbacks: VoiceRecognitionCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public initialize(options?: { lang?: string }): boolean {
    this.cleanup();
    const rec = createBrowserSpeechRecognition(options);
    if (!rec) return false;

    this.recognition = rec;
    rec.onstart = () => {
      this.isBusy = true;
      this.callbacks.onStart?.();
    };

    rec.onend = () => {
      this.isBusy = false;
      this.callbacks.onEnd?.();
      if (this.isWanted) {
        this.clearRestartTimer();
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.isWanted && !this.isBusy && this.recognition) {
            try {
              this.isBusy = true;
              this.recognition.start();
            } catch {
              this.isBusy = false;
            }
          }
        }, 350);
      }
    };

    rec.onerror = (event: { error: string }) => {
      this.isBusy = false;
      const isPermissionDenied =
        event.error === 'not-allowed' || event.error === 'service-not-allowed';
      if (isPermissionDenied) {
        this.isWanted = false;
        this.clearRestartTimer();
      }
      this.callbacks.onError?.(event.error, isPermissionDenied);
    };

    rec.onresult = (event: SpeechRecognitionEventLike) => {
      const transcript = combineRecognitionResults(event.results);
      this.callbacks.onTranscript?.(transcript);
    };

    return true;
  }

  public start(): void {
    this.isWanted = true;
    this.clearRestartTimer();

    if (!this.recognition || this.isBusy) {
      return;
    }

    try {
      this.isBusy = true;
      this.recognition.start();
    } catch {
      this.isBusy = false;
    }
  }

  public stop(flush = false): void {
    this.isWanted = false;
    this.clearRestartTimer();

    if (!this.recognition) return;

    try {
      if (this.isBusy) {
        if (flush) {
          this.recognition.stop();
        } else {
          this.recognition.abort();
        }
      }
    } catch {
      // Ignore if recognition is in an unready state
    } finally {
      if (!flush) {
        this.isBusy = false;
      }
    }
  }

  public abort(): void {
    this.stop(false);
  }

  public cleanup(): void {
    this.isWanted = false;
    this.clearRestartTimer();

    if (this.recognition) {
      this.recognition.onstart = null;
      this.recognition.onend = null;
      this.recognition.onerror = null;
      this.recognition.onresult = null;
      try {
        this.recognition.abort();
      } catch {
        // noop
      }
      this.recognition = null;
    }

    this.isBusy = false;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  public getStatus(): { isBusy: boolean; isWanted: boolean; hasInstance: boolean } {
    return {
      isBusy: this.isBusy,
      isWanted: this.isWanted,
      hasInstance: Boolean(this.recognition),
    };
  }
}
