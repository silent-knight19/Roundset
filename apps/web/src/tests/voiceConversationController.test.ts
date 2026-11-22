import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationController } from '../lib/voice/conversationController';
import * as recognitionModule from '../lib/voice/recognition';
import * as vadModule from '../lib/voice/vad';
import * as ttsModule from '../lib/voice/tts';
import { INITIAL_QUESTION } from '../lib/voice/scriptedInterviewer';

describe('ConversationController', () => {
  let mockRecognitionAdapter: {
    initialize: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    callbacks?: recognitionModule.VoiceRecognitionCallbacks;
  };

  let mockVADAdapter: {
    initialize: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    callbacks?: vadModule.VADCallbacks;
  };

  let mockActiveAudio: ttsModule.ActiveAudio;
  let audioCallbacks: {
    onPlaying?: () => void;
    onEnded?: () => void;
    onError?: (err: unknown) => void;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    vi.spyOn(recognitionModule, 'isSpeechRecognitionSupported').mockReturnValue(true);

    mockRecognitionAdapter = {
      initialize: vi.fn().mockReturnValue(true),
      start: vi.fn(),
      stop: vi.fn(),
      cleanup: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ isBusy: false, isWanted: false, hasInstance: true }),
    };

    vi.spyOn(recognitionModule, 'VoiceRecognitionAdapter').mockImplementation(
      function (this: unknown, cbs?: recognitionModule.VoiceRecognitionCallbacks) {
        mockRecognitionAdapter.callbacks = cbs;
        return mockRecognitionAdapter as unknown as recognitionModule.VoiceRecognitionAdapter;
      },
    );

    mockVADAdapter = {
      initialize: vi.fn().mockResolvedValue(true),
      start: vi.fn().mockResolvedValue(true),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({
        isRunning: false,
        isInitializing: false,
        hasInstance: true,
        generation: 1,
        detectorGeneration: 1,
      }),
    };

    vi.spyOn(vadModule, 'VADAdapter').mockImplementation(
      function (this: unknown, cbs?: vadModule.VADCallbacks) {
        mockVADAdapter.callbacks = cbs;
        return mockVADAdapter as unknown as vadModule.VADAdapter;
      },
    );

    vi.spyOn(ttsModule, 'synthesizeKokoro').mockResolvedValue({
      blob: new Blob(['audio']),
      device: 'wasm',
      modelLoadMs: 50,
    });

    mockActiveAudio = {
      player: {
        pause: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
      } as unknown as HTMLAudioElement,
      url: 'blob:test-audio-url',
    };

    vi.spyOn(ttsModule, 'playAudioBlob').mockImplementation((_blob, cbs) => {
      audioCallbacks = cbs || {};
      return mockActiveAudio;
    });

    vi.spyOn(ttsModule, 'cancelAudio').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs normal scripted question/answer flow (Requirement 5)', async () => {
    const controller = new ConversationController();
    await controller.startSession();

    // 1. Setup completed, AI asks initial Java question
    const msgs1 = controller.getState().messages;
    expect(msgs1).toHaveLength(1);
    expect(msgs1[0]?.text).toBe(INITIAL_QUESTION);
    expect(controller.getState().stage).toBe('generating');

    // 2. Audio plays
    audioCallbacks.onPlaying?.();
    expect(controller.getState().stage).toBe('speaking');

    // 3. Audio finishes, transitions to listening
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');
    expect(mockRecognitionAdapter.start).toHaveBeenCalled();

    // 4. Candidate speaks
    mockVADAdapter.callbacks?.onSpeechStart?.();
    expect(controller.getState().vadSpeech).toBe(true);

    mockRecognitionAdapter.callbacks?.onTranscript?.({
      final: 'Interfaces provide full abstraction and multiple inheritance',
      interim: '',
      display: 'Interfaces provide full abstraction and multiple inheritance',
    });
    expect(controller.getState().draft).toBe(
      'Interfaces provide full abstraction and multiple inheritance',
    );

    // 5. Candidate stops speaking -> processing -> 650ms timer
    mockVADAdapter.callbacks?.onSpeechEnd?.();
    expect(controller.getState().stage).toBe('processing');

    // Advance 650ms timer to trigger answer submission
    await vi.advanceTimersByTimeAsync(650);

    // 6. Scripted follow-up question is selected and spoken
    const msgs2 = controller.getState().messages;
    expect(msgs2).toHaveLength(3);
    expect(msgs2[1]?.role).toBe('candidate');
    expect(msgs2[2]?.role).toBe('interviewer');
    expect(msgs2[2]?.text).toContain(
      'Can you describe a real Java design where using an interface was preferable',
    );
  });

  it('handles user interruption during speech playback (Requirement 6)', async () => {
    const controller = new ConversationController();
    await controller.startSession();
    audioCallbacks.onPlaying?.();
    expect(controller.getState().stage).toBe('speaking');

    // User interrupts by speaking while AI is speaking
    mockVADAdapter.callbacks?.onSpeechStart?.();

    expect(controller.getState().interruptedCount).toBe(1);
    expect(controller.getState().stage).toBe('listening');
    expect(ttsModule.cancelAudio).toHaveBeenCalled();
    expect(mockRecognitionAdapter.start).toHaveBeenCalled();
  });

  it('handles repeated interruptions without breaking state (Requirement 7)', async () => {
    const controller = new ConversationController();
    await controller.startSession();

    // Interruption 1
    audioCallbacks.onPlaying?.();
    mockVADAdapter.callbacks?.onSpeechStart?.();
    expect(controller.getState().interruptedCount).toBe(1);
    expect(controller.getState().stage).toBe('listening');

    // Candidate speaks and submits answer
    mockRecognitionAdapter.callbacks?.onTranscript?.({
      final: 'Interruption answer 1',
      interim: '',
      display: 'Interruption answer 1',
    });
    mockVADAdapter.callbacks?.onSpeechEnd?.();
    await vi.advanceTimersByTimeAsync(650);

    // Interruption 2 while next reply is speaking
    audioCallbacks.onPlaying?.();
    mockVADAdapter.callbacks?.onSpeechStart?.();
    expect(controller.getState().interruptedCount).toBe(2);
    expect(controller.getState().stage).toBe('listening');

    // Interruption 3
    controller.manualInterrupt();
    // In listening stage, manual interrupt is a no-op; only active during speaking/generating
    expect(controller.getState().interruptedCount).toBe(2);
  });

  it('aborts cleanly if stop is requested during initialization (Requirement 8)', async () => {
    let resolveInit: (val: boolean) => void = () => {};
    mockVADAdapter.initialize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInit = resolve;
        }),
    );

    const controller = new ConversationController();
    const startPromise = controller.startSession();

    expect(controller.getState().stage).toBe('setup');

    // User clicks stop while still initializing
    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // Now async VAD resolves late
    resolveInit(true);
    await startPromise;

    // Must remain stopped; must not start speaking
    expect(controller.getState().stage).toBe('stopped');
    expect(mockVADAdapter.cleanup).toHaveBeenCalled();
  });

  it('discards generated audio if stop occurs during TTS generation (Requirement 9 & 11)', async () => {
    let resolveTTS: (output: ttsModule.TTSOutput) => void = () => {};
    vi.spyOn(ttsModule, 'synthesizeKokoro').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTTS = resolve as unknown as typeof resolveTTS;
        }),
    );

    const controller = new ConversationController();
    const startPromise = controller.startSession();

    // Allow microtasks so startSession reaches TTS synthesis
    await vi.waitFor(() => {
      expect(controller.getState().stage).toBe('generating');
    });

    // Stop session while TTS is in flight
    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // Stale TTS promise resolves after cancellation
    resolveTTS({
      blob: new Blob(['stale audio']),
      device: 'wasm',
      modelLoadMs: 100,
    });
    await startPromise;

    // Stale audio should never have been played
    expect(ttsModule.playAudioBlob).not.toHaveBeenCalled();
    expect(controller.getState().stage).toBe('stopped');
  });

  it('keeps candidate turn open if speech resumes during the 650ms finalize window', async () => {
    const controller = new ConversationController();
    await controller.startSession();
    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();

    mockRecognitionAdapter.callbacks?.onTranscript?.({
      final: 'First part of my thought',
      interim: '',
      display: 'First part of my thought',
    });

    // Pause detected -> processing
    mockVADAdapter.callbacks?.onSpeechEnd?.();
    expect(controller.getState().stage).toBe('processing');

    // Candidate speaks again 200ms into the pause window
    vi.advanceTimersByTime(200);
    mockVADAdapter.callbacks?.onSpeechStart?.();

    // Turn is kept open, stage reverts to listening
    expect(controller.getState().stage).toBe('listening');
    expect(controller.getState().status).toContain('Keeping your answer open');

    // Advance beyond 650ms from original pause; turn was NOT submitted
    await vi.advanceTimersByTimeAsync(700);
    expect(controller.getState().messages).toHaveLength(1); // Only initial question
  });

  it('supports manual interruption and manual typed answer submission', async () => {
    const controller = new ConversationController();
    await controller.startSession();

    // Manual interrupt during speaking
    audioCallbacks.onPlaying?.();
    controller.manualInterrupt();
    expect(controller.getState().interruptedCount).toBe(1);
    expect(controller.getState().stage).toBe('listening');

    // Manual typed answer
    controller.updateDraft('Manually typed architectural explanation');
    await controller.submitAnswer('Manually typed architectural explanation');

    const msgs = controller.getState().messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[1]?.text).toBe(
      'Manually typed architectural explanation',
    );
  });

  it('stop during pending initialization does NOT transition to ERROR on late rejection (R2)', async () => {
    let rejectInit: (err: unknown) => void = () => {};
    mockVADAdapter.initialize.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectInit = reject;
        }),
    );

    const controller = new ConversationController();
    const startPromise = controller.startSession();

    expect(controller.getState().stage).toBe('setup');

    // User clicks stop while still initializing
    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // Late rejection occurs
    rejectInit(new Error('Microphone permission denied'));
    await startPromise;

    // Must remain stopped; must NOT transition to error
    expect(controller.getState().stage).toBe('stopped');
  });

  it('stop followed by immediate restart: previous session late failure does NOT terminate new session (R2)', async () => {
    let rejectFirstInit: (err: unknown) => void = () => {};
    mockVADAdapter.initialize
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirstInit = reject;
          }),
      )
      .mockResolvedValueOnce(true);

    const controller = new ConversationController();
    const session1Promise = controller.startSession();
    expect(controller.getState().stage).toBe('setup');

    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // Start session 2 immediately
    const session2Promise = controller.startSession();
    await vi.waitFor(() => {
      expect(controller.getState().stage).toBe('generating');
    });

    // Session 1 rejects late
    rejectFirstInit(new Error('Stale failure from session 1'));
    await session1Promise;

    // Session 2 is unaffected and still healthy
    expect(controller.getState().stage).toBe('generating');
    expect(controller.getState().messages).toHaveLength(1);
    await session2Promise;
  });

  it('treats VADAdapter.initialize() === false as failure and enters typed-only mode (R2/R3)', async () => {
    mockVADAdapter.initialize.mockResolvedValueOnce(false);

    const controller = new ConversationController();
    await controller.startSession();

    expect(controller.getState().inputMode).toBe('typed_only');
    expect(controller.getState().microphoneActive).toBe(false);
    expect(mockVADAdapter.start).not.toHaveBeenCalled();
    // Still speaks the initial question using Kokoro TTS
    expect(controller.getState().messages[0]?.text).toBe(INITIAL_QUESTION);

    // When audio finishes, status prompts for typed response
    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');
    expect(controller.getState().status).toContain('Type your answer');
  });

  it('starts in typed-only mode when SpeechRecognition is unsupported (R3)', async () => {
    vi.spyOn(recognitionModule, 'isSpeechRecognitionSupported').mockReturnValue(false);

    const controller = new ConversationController();
    await controller.startSession();

    expect(controller.getState().inputMode).toBe('typed_only');
    expect(controller.getState().microphoneActive).toBe(false);
    expect(mockRecognitionAdapter.initialize).not.toHaveBeenCalled();
    expect(mockVADAdapter.initialize).not.toHaveBeenCalled();

    // Speaks initial question
    audioCallbacks.onPlaying?.();
    expect(controller.getState().stage).toBe('speaking');
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');

    // Candidate types and submits answer
    await controller.submitAnswer('Typed architectural response');
    expect(controller.getState().messages[1]?.text).toBe('Typed architectural response');
    expect(controller.getState().stage).toBe('generating');
  });

  it('handles microphone permission denial gracefully by switching to typed-only mode (R3)', async () => {
    mockVADAdapter.initialize.mockRejectedValueOnce(
      new Error('NotAllowedError: Permission denied'),
    );

    const controller = new ConversationController();
    await controller.startSession();

    expect(controller.getState().stage).toBe('generating');
    expect(controller.getState().inputMode).toBe('typed_only');
    expect(controller.getState().microphoneActive).toBe(false);

    // Audio finishes, status prompts for typed response
    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');
    expect(controller.getState().status).toContain('Type your answer');
  });

  it('R2-01: Session A initialization resolution never destroys Session B detector', async () => {
    let resolveSessionAInit: (val: boolean) => void = () => {};
    const pendingSessionAPromise = new Promise<boolean>((resolve) => {
      resolveSessionAInit = resolve;
    });

    mockVADAdapter.initialize
      .mockReturnValueOnce(pendingSessionAPromise)
      .mockResolvedValueOnce(true);

    const controller = new ConversationController();

    // 1. Begin Session A with VAD initialization pending
    const sessionAPromise = controller.startSession();
    expect(controller.getState().stage).toBe('setup');

    // 2. Stop A
    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // 3. Start Session B and successfully initialize its detector
    const sessionBPromise = controller.startSession();
    await vi.waitFor(() => {
      expect(controller.getState().stage).toBe('generating');
    });

    // Reset destroy mock call history after session A's stop
    mockVADAdapter.destroy.mockClear();
    mockVADAdapter.cleanup.mockClear();

    // 4. Resolve A's initialization
    resolveSessionAInit(false);
    await sessionAPromise;

    // 5. Assert B's detector remains active, destruction was not called on B, and B continues
    expect(mockVADAdapter.destroy).not.toHaveBeenCalled();
    expect(mockVADAdapter.cleanup).not.toHaveBeenCalled();
    expect(controller.getState().stage).toBe('generating');
    expect(controller.getState().microphoneActive).toBe(true);

    // B continues receiving speech callbacks
    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');

    mockVADAdapter.callbacks?.onSpeechStart?.();
    expect(controller.getState().vadSpeech).toBe(true);

    await sessionBPromise;
  });

  it('R2-02: handles VAD startup failure when start() throws or rejects', async () => {
    mockVADAdapter.start.mockRejectedValueOnce(new Error('AudioContext failed to start'));

    const controller = new ConversationController();
    await controller.startSession();

    // Must fall back to typed-only mode with microphoneActive = false
    expect(controller.getState().inputMode).toBe('typed_only');
    expect(controller.getState().microphoneActive).toBe(false);
    expect(controller.getState().stage).toBe('generating');

    // Speaks initial question
    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');

    // Candidate submits typed answer and receives follow-up
    await controller.submitAnswer('Typed fallback response after start failure');
    expect(controller.getState().messages[1]?.text).toBe(
      'Typed fallback response after start failure',
    );
  });

  it('R2-02: does not mark session active if stopped during pending VAD start', async () => {
    let resolveStart: (val: boolean) => void = () => {};
    mockVADAdapter.start.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const controller = new ConversationController();
    const startPromise = controller.startSession();
    expect(controller.getState().stage).toBe('setup');

    // Stop while start() is in flight
    controller.stopSession();
    expect(controller.getState().stage).toBe('stopped');

    // Late start resolution
    resolveStart(true);
    await startPromise;

    // Must remain stopped; microphoneActive must be false
    expect(controller.getState().stage).toBe('stopped');
    expect(controller.getState().microphoneActive).toBe(false);
  });

  it('R2-03: releases VAD detector and recognition on runtime permission denial while preserving typed flow and draft', async () => {
    const controller = new ConversationController();
    await controller.startSession();

    audioCallbacks.onPlaying?.();
    audioCallbacks.onEnded?.();
    expect(controller.getState().stage).toBe('listening');
    expect(controller.getState().microphoneActive).toBe(true);

    // Candidate entered draft text before permission error
    controller.updateDraft('Candidate partially typed text');

    // Trigger runtime permission denial
    mockRecognitionAdapter.callbacks?.onError?.('not-allowed', true);

    // Assert typed-only mode is entered
    expect(controller.getState().inputMode).toBe('typed_only');
    expect(controller.getState().microphoneActive).toBe(false);

    // Assert user-entered draft text is preserved
    expect(controller.getState().draft).toBe('Candidate partially typed text');

    // Assert VAD destruction and recognition cleanup occurred
    expect(mockVADAdapter.destroy).toHaveBeenCalled();
    expect(mockRecognitionAdapter.cleanup).toHaveBeenCalled();

    // Confirm candidate can still submit answer and receive scripted follow-up
    await controller.submitAnswer('Candidate partially typed text');
    const msgs = controller.getState().messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[1]?.text).toBe('Candidate partially typed text');
    expect(msgs[2]?.role).toBe('interviewer');
  });

  it('resets session metrics and state cleanly', async () => {
    const controller = new ConversationController();
    await controller.startSession();
    controller.stopSession();

    controller.reset();
    expect(controller.getState().stage).toBe('idle');
    expect(controller.getState().messages).toHaveLength(0);
    expect(controller.getState().interruptedCount).toBe(0);
    expect(controller.getState().draft).toBe('');
  });
});
