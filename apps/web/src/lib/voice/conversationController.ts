import {
  VoiceRecognitionAdapter,
  isSpeechRecognitionSupported,
  type RecognitionTranscript,
} from './recognition';
import { VADAdapter } from './vad';
import {
  synthesizeKokoro,
  playAudioBlob,
  cancelAudio,
  getActiveKokoroDevice,
  type ActiveAudio,
} from './tts';
import { INITIAL_QUESTION, nextDemoQuestion } from './scriptedInterviewer';

export type VoiceStage =
  | 'idle'
  | 'setup'
  | 'generating'
  | 'speaking'
  | 'listening'
  | 'processing'
  | 'stopped'
  | 'error';

export const VOICE_STAGE_LABELS: Record<VoiceStage, string> = {
  idle: 'Ready to start',
  setup: 'Starting microphone and VAD',
  generating: 'Preparing interviewer voice',
  speaking: 'AI interviewer speaking',
  listening: 'Listening for your answer',
  processing: 'Processing your answer',
  stopped: 'Session stopped',
  error: 'Session error',
};

export interface VoiceMessage {
  id: number;
  role: 'interviewer' | 'candidate';
  text: string;
}

export interface VoiceControllerState {
  stage: VoiceStage;
  status: string;
  voice: string;
  draft: string;
  messages: VoiceMessage[];
  interruptedCount: number;
  latencyMs: number | null;
  vadSpeech: boolean;
  modelDevice: string;
  eventLog: string[];
}

export class ConversationController {
  private stage: VoiceStage = 'idle';
  private status = 'Chrome or Edge recommended. Wear headphones for reliable interruptions.';
  private voice = 'af_heart';
  private draft = '';
  private messages: VoiceMessage[] = [];
  private interruptedCount = 0;
  private latencyMs: number | null = null;
  private vadSpeech = false;
  private eventLog: string[] = [];

  private isRunning = false;
  private sessionId = 0;
  private activeToken = 0;
  private messageSeq = 0;
  private turnCount = 0;
  private answerSentAt: number | null = null;

  private recognitionAdapter: VoiceRecognitionAdapter;
  private vadAdapter: VADAdapter;
  private currentAudio: ActiveAudio | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  private onStateChange?: (state: VoiceControllerState) => void;

  constructor(callbacks?: { onStateChange?: (state: VoiceControllerState) => void }) {
    this.onStateChange = callbacks?.onStateChange;

    this.recognitionAdapter = new VoiceRecognitionAdapter({
      onTranscript: (t: RecognitionTranscript) => this.handleTranscript(t),
      onError: (err: string, isDenied: boolean) => this.handleRecognitionError(err, isDenied),
    });

    this.vadAdapter = new VADAdapter({
      onSpeechStart: () => this.handleVoiceStart(),
      onSpeechEnd: () => this.handleVoiceEnd(),
      onVADMisfire: () => {
        this.vadSpeech = false;
        this.emitState();
      },
    });
  }

  public setVoice(voice: string): void {
    this.voice = voice;
    this.emitState();
  }

  public getState(): VoiceControllerState {
    return {
      stage: this.stage,
      status: this.status,
      voice: this.voice,
      draft: this.draft,
      messages: [...this.messages],
      interruptedCount: this.interruptedCount,
      latencyMs: this.latencyMs,
      vadSpeech: this.vadSpeech,
      modelDevice: getActiveKokoroDevice(),
      eventLog: [...this.eventLog],
    };
  }

  private emitState(): void {
    this.onStateChange?.(this.getState());
  }

  private setStage(stage: VoiceStage): void {
    this.stage = stage;
    this.emitState();
  }

  private setStatus(status: string): void {
    this.status = status;
    this.emitState();
  }

  private logEvent(event: string): void {
    const time = new Date().toLocaleTimeString();
    this.eventLog = [`${time}  ${event}`, ...this.eventLog].slice(0, 16);
    this.emitState();
  }

  private appendMessage(role: 'interviewer' | 'candidate', text: string): void {
    this.messages = [...this.messages, { id: ++this.messageSeq, role, text }];
    this.emitState();
  }

  private clearTimers(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
  }

  private clearActiveAudio(): void {
    if (this.currentAudio) {
      cancelAudio(this.currentAudio);
      this.currentAudio = null;
    }
  }

  private clearPendingAsync(): void {
    ++this.activeToken;
    this.clearActiveAudio();
  }

  public async startSession(): Promise<void> {
    if (this.isRunning) return;

    if (!isSpeechRecognitionSupported()) {
      this.setStage('error');
      this.setStatus('Browser speech recognition unavailable. Try Chrome or Edge.');
      return;
    }

    this.isRunning = true;
    const currentSession = ++this.sessionId;
    this.interruptedCount = 0;
    this.latencyMs = null;
    this.messages = [];
    this.eventLog = [];
    this.turnCount = 0;
    this.draft = '';
    this.vadSpeech = false;

    this.setStage('setup');
    this.setStatus('Loading local Silero VAD and requesting microphone access…');
    this.logEvent('Initializing session');

    try {
      const recInitialized = this.recognitionAdapter.initialize();
      if (!recInitialized) {
        throw new Error('Web Speech recognition failed to initialize');
      }

      await this.vadAdapter.initialize();

      if (!this.isRunning || currentSession !== this.sessionId) {
        this.vadAdapter.cleanup();
        this.recognitionAdapter.cleanup();
        return;
      }

      this.vadAdapter.start();
      this.logEvent('Silero VAD initialized · microphone active');

      this.appendMessage('interviewer', INITIAL_QUESTION);
      await this.speak(INITIAL_QUESTION);
    } catch (error) {
      this.stopSession();
      this.setStage('error');
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus(`Setup failed: ${msg}. Check microphone permissions and network access.`);
    }
  }

  public stopSession(): void {
    ++this.sessionId;
    this.isRunning = false;
    this.clearPendingAsync();
    this.clearTimers();
    this.recognitionAdapter.stop(false);
    this.recognitionAdapter.cleanup();
    this.vadAdapter.cleanup();
    this.vadSpeech = false;
    this.setStage('stopped');
    this.setStatus('Session stopped. No audio files or transcripts were saved to disk.');
    this.logEvent('Session stopped');
  }

  public manualInterrupt(): void {
    if (!this.isRunning) return;
    if (this.stage === 'speaking' || this.stage === 'generating') {
      this.interruptedCount++;
      this.logEvent('Manual interruption');
      this.clearPendingAsync();
      this.draft = '';
      this.setStage('listening');
      this.setStatus('Audio stopped. You may speak or type.');
      this.recognitionAdapter.start();
    }
  }

  public playPreparedAudio(): void {
    if (this.currentAudio) {
      this.currentAudio.player.play().catch(() => {
        this.setStatus('Browser refused playback; check site audio permissions.');
      });
    }
  }

  public reset(): void {
    if (this.isRunning) {
      this.stopSession();
    }
    this.messages = [];
    this.eventLog = [];
    this.draft = '';
    this.interruptedCount = 0;
    this.latencyMs = null;
    this.setStage('idle');
    this.setStatus('Ready to start a new conversation.');
  }

  public updateDraft(text: string): void {
    this.draft = text;
    this.emitState();
  }

  public async submitAnswer(text: string): Promise<void> {
    const answer = text.trim();
    if (
      !this.isRunning ||
      !answer ||
      (this.stage !== 'listening' && this.stage !== 'processing')
    ) {
      return;
    }

    this.clearTimers();
    this.recognitionAdapter.stop(false);
    const currentToken = ++this.activeToken;

    this.setStage('processing');
    this.draft = '';
    this.appendMessage('candidate', answer);
    this.setStatus('Preparing scripted follow-up…');
    this.answerSentAt = performance.now();
    this.turnCount++;

    const followUp = nextDemoQuestion(answer, this.turnCount);

    if (!this.isRunning || this.activeToken !== currentToken) return;

    this.appendMessage('interviewer', followUp);
    this.logEvent('Scripted reply generated');
    await this.speak(followUp);
  }

  private async speak(text: string): Promise<void> {
    if (!this.isRunning) return;
    const currentToken = ++this.activeToken;

    this.setStage('generating');
    this.recognitionAdapter.stop(false);
    this.setStatus('Synthesizing locally with Kokoro. First model load may be slow.');

    const startMs = performance.now();
    try {
      const output = await synthesizeKokoro(text, this.voice);

      if (!this.isRunning || this.activeToken !== currentToken) {
        return;
      }

      this.currentAudio = playAudioBlob(output.blob, {
        onPlaying: () => {
          if (this.activeToken !== currentToken) return;
          this.setStage('speaking');
          this.setStatus('AI speaking. Speak into microphone to interrupt it. Wear headphones.');
          if (this.answerSentAt !== null) {
            this.latencyMs = Math.round(performance.now() - this.answerSentAt);
            this.answerSentAt = null;
          }
          this.logEvent(
            `Kokoro playback · ${Math.round(performance.now() - startMs)}ms after TTS start`,
          );
        },
        onEnded: () => {
          if (this.activeToken !== currentToken || !this.isRunning) return;
          this.clearActiveAudio();
          this.setStage('listening');
          this.setStatus('Your turn. Speak naturally; pause to send your answer.');
          this.draft = '';
          this.recognitionAdapter.start();
        },
        onError: () => {
          if (this.activeToken !== currentToken) return;
          this.clearActiveAudio();
          this.setStage('listening');
          this.setStatus('Kokoro playback failed. You can still answer by voice or typing.');
          this.recognitionAdapter.start();
        },
      });
    } catch (error) {
      if (this.activeToken !== currentToken || !this.isRunning) return;
      this.setStage('listening');
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus(`Kokoro failed: ${msg}. You can type instead.`);
      this.recognitionAdapter.start();
    }
  }

  private handleVoiceStart(): void {
    if (!this.isRunning) return;
    this.vadSpeech = true;
    this.emitState();

    if (this.stage === 'processing' && this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
      this.setStage('listening');
      this.setStatus('You continued speaking. Keeping your answer open…');
      this.recognitionAdapter.start();
      return;
    }

    if (this.stage === 'speaking' || this.stage === 'generating') {
      this.logEvent('Barge-in detected: AI voice interrupted');
      this.interruptedCount++;
      this.clearPendingAsync();
      this.recognitionAdapter.stop(false);
      this.draft = '';
      this.setStage('listening');
      this.setStatus('Interruption detected. Listening to you now…');
      this.recognitionAdapter.start();
    } else if (this.stage === 'listening') {
      this.clearTimers();
      this.recognitionAdapter.start();
    }
  }

  private handleVoiceEnd(): void {
    if (!this.isRunning) return;
    this.vadSpeech = false;
    this.emitState();

    if (this.stage !== 'listening') return;

    this.setStage('processing');
    this.setStatus('Pause detected. Waiting for final transcript…');
    this.recognitionAdapter.stop(true);

    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      if (!this.isRunning || this.stage !== 'processing') return;

      const latest = this.draft.trim();
      if (latest) {
        void this.submitAnswer(latest);
      } else {
        this.setStage('listening');
        this.setStatus('Speech detected but no words recognized. Retry or type below.');
        this.recognitionAdapter.start();
      }
    }, 650);
  }

  private handleTranscript(transcript: RecognitionTranscript): void {
    if (
      !this.isRunning ||
      (this.stage !== 'listening' && this.stage !== 'processing')
    ) {
      return;
    }
    this.draft = transcript.display;
    this.emitState();
  }

  private handleRecognitionError(error: string, isPermissionDenied: boolean): void {
    if (isPermissionDenied) {
      this.setStatus(
        'Browser speech recognition was denied. Use text input or grant microphone permissions.',
      );
    } else if (error !== 'aborted' && error !== 'no-speech') {
      this.logEvent(`Speech recognition warning: ${error}`);
    }
  }

  public cleanup(): void {
    this.stopSession();
    this.onStateChange = undefined;
  }
}
