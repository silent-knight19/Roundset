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

export type VoiceInputMode = 'voice' | 'typed_only';

export const VOICE_STAGE_LABELS: Record<VoiceStage, string> = {
  idle: 'Ready to start',
  setup: 'Initializing laboratory session',
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
  inputMode: VoiceInputMode;
  draft: string;
  messages: VoiceMessage[];
  interruptedCount: number;
  latencyMs: number | null;
  vadSpeech: boolean;
  microphoneActive: boolean;
  modelDevice: string;
  eventLog: string[];
}

export class ConversationController {
  private stage: VoiceStage = 'idle';
  private status =
    'Desktop Chrome or Edge recommended. External network required on first load for models. Wear headphones for interruptions.';
  private voice = 'af_heart';
  private inputMode: VoiceInputMode = 'voice';
  private draft = '';
  private messages: VoiceMessage[] = [];
  private interruptedCount = 0;
  private latencyMs: number | null = null;
  private vadSpeech = false;
  private microphoneActive = false;
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
      inputMode: this.inputMode,
      draft: this.draft,
      messages: [...this.messages],
      interruptedCount: this.interruptedCount,
      latencyMs: this.latencyMs,
      vadSpeech: this.vadSpeech,
      microphoneActive: this.microphoneActive,
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

    this.isRunning = true;
    const currentSession = ++this.sessionId;
    this.interruptedCount = 0;
    this.latencyMs = null;
    this.messages = [];
    this.eventLog = [];
    this.turnCount = 0;
    this.draft = '';
    this.vadSpeech = false;
    this.microphoneActive = false;

    this.setStage('setup');
    this.setStatus('Initializing voice pipeline and testing audio input capabilities…');
    this.logEvent(`Session #${currentSession} starting`);

    const hasSpeechRecognition = isSpeechRecognitionSupported();
    let voiceInputAvailable = false;

    if (hasSpeechRecognition) {
      try {
        const recOk = this.recognitionAdapter.initialize();
        if (recOk) {
          const vadOk = await this.vadAdapter.initialize();
          if (!this.isRunning || currentSession !== this.sessionId) {
            // Obsolete or stopped session: clean up immediately and ignore
            await this.vadAdapter.cleanup();
            this.recognitionAdapter.cleanup();
            return;
          }

          if (vadOk) {
            await this.vadAdapter.start();
            this.microphoneActive = true;
            voiceInputAvailable = true;
            this.logEvent('Silero VAD initialized · microphone active');
          } else {
            this.logEvent('VAD initialization returned false; falling back to typed-only mode');
          }
        }
      } catch (voiceError) {
        if (!this.isRunning || currentSession !== this.sessionId) {
          // Late rejection belonging to an obsolete/stopped session must not alter state
          return;
        }
        const msg = voiceError instanceof Error ? voiceError.message : String(voiceError);
        this.logEvent(`Voice input initialization failed (${msg}); falling back to typed mode`);
      }
    } else {
      this.logEvent('Browser SpeechRecognition unsupported; operating in typed-only mode');
    }

    if (!this.isRunning || currentSession !== this.sessionId) {
      return;
    }

    if (voiceInputAvailable) {
      this.inputMode = 'voice';
    } else {
      this.inputMode = 'typed_only';
      this.microphoneActive = false;
      this.setStatus(
        'Microphone / SpeechRecognition unavailable. Running in typed-answer mode. Type your answers below.',
      );
    }

    this.appendMessage('interviewer', INITIAL_QUESTION);
    await this.speak(INITIAL_QUESTION, currentSession);
  }

  public stopSession(): void {
    ++this.sessionId;
    this.isRunning = false;
    this.clearPendingAsync();
    this.clearTimers();
    this.recognitionAdapter.stop(false);
    this.recognitionAdapter.cleanup();
    void this.vadAdapter.cleanup();
    this.vadSpeech = false;
    this.microphoneActive = false;
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
      this.setStatus(
        this.inputMode === 'voice'
          ? 'Audio stopped. You may speak or type.'
          : 'Audio stopped. Please type your answer below.',
      );
      if (this.inputMode === 'voice') {
        this.recognitionAdapter.start();
      }
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
    this.vadSpeech = false;
    this.microphoneActive = false;
    this.inputMode = 'voice';
    this.setStage('idle');
    this.setStatus('Ready to start a new scripted conversation.');
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
    if (this.inputMode === 'voice') {
      this.recognitionAdapter.stop(false);
    }

    const currentToken = ++this.activeToken;
    const currentSession = this.sessionId;

    this.setStage('processing');
    this.draft = '';
    this.appendMessage('candidate', answer);
    this.setStatus('Preparing scripted follow-up question…');
    this.answerSentAt = performance.now();
    this.turnCount++;

    const followUp = nextDemoQuestion(answer, this.turnCount);

    if (!this.isRunning || this.activeToken !== currentToken || this.sessionId !== currentSession) {
      return;
    }

    this.appendMessage('interviewer', followUp);
    this.logEvent('Scripted reply generated');
    await this.speak(followUp, currentSession);
  }

  private async speak(text: string, sessionGen: number): Promise<void> {
    if (!this.isRunning || this.sessionId !== sessionGen) return;
    const currentToken = ++this.activeToken;

    this.setStage('generating');
    if (this.inputMode === 'voice') {
      this.recognitionAdapter.stop(false);
    }
    this.setStatus('Synthesizing interviewer speech locally with Kokoro (ONNX)…');

    const startMs = performance.now();
    try {
      const output = await synthesizeKokoro(text, this.voice);

      if (
        !this.isRunning ||
        this.activeToken !== currentToken ||
        this.sessionId !== sessionGen
      ) {
        return;
      }

      this.currentAudio = playAudioBlob(output.blob, {
        onPlaying: () => {
          if (this.activeToken !== currentToken || this.sessionId !== sessionGen) return;
          this.setStage('speaking');
          this.setStatus(
            this.inputMode === 'voice'
              ? 'AI speaking. Speak into microphone to interrupt it. Use headphones.'
              : 'AI speaking. Listen or type your answer below.',
          );
          if (this.answerSentAt !== null) {
            this.latencyMs = Math.round(performance.now() - this.answerSentAt);
            this.answerSentAt = null;
          }
          this.logEvent(
            `Kokoro playback · ${Math.round(performance.now() - startMs)}ms after synthesis start`,
          );
        },
        onEnded: () => {
          if (this.activeToken !== currentToken || this.sessionId !== sessionGen || !this.isRunning) {
            return;
          }
          this.clearActiveAudio();
          this.setStage('listening');
          this.setStatus(
            this.inputMode === 'voice'
              ? 'Your turn. Speak naturally; pause to send your answer.'
              : 'Your turn. Type your answer and click Send Answer.',
          );
          this.draft = '';
          if (this.inputMode === 'voice') {
            this.recognitionAdapter.start();
          }
        },
        onError: () => {
          if (this.activeToken !== currentToken || this.sessionId !== sessionGen) return;
          this.clearActiveAudio();
          this.setStage('listening');
          this.setStatus(
            'Kokoro audio playback failed. You can still answer by typing below.',
          );
          if (this.inputMode === 'voice') {
            this.recognitionAdapter.start();
          }
        },
      });
    } catch (error) {
      if (
        this.activeToken !== currentToken ||
        this.sessionId !== sessionGen ||
        !this.isRunning
      ) {
        return;
      }
      this.setStage('listening');
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatus(`Kokoro synthesis unavailable (${msg}). Please type your answer below.`);
      if (this.inputMode === 'voice') {
        this.recognitionAdapter.start();
      }
    }
  }

  private handleVoiceStart(): void {
    if (!this.isRunning || this.inputMode !== 'voice') return;
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
    if (!this.isRunning || this.inputMode !== 'voice') return;
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
      this.inputMode = 'typed_only';
      this.microphoneActive = false;
      this.setStatus(
        'Microphone/SpeechRecognition permission was denied. Switched to typed-answer mode.',
      );
      this.logEvent('Microphone permission denied; switched to typed-only mode');
    } else if (error !== 'aborted' && error !== 'no-speech') {
      this.logEvent(`Speech recognition warning: ${error}`);
    }
  }

  public cleanup(): void {
    this.stopSession();
    this.onStateChange = undefined;
  }
}
