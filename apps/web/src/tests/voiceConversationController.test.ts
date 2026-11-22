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
      start: vi.fn(),
      pause: vi.fn(),
      cleanup: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ isRunning: false, isInitializing: false, hasInstance: true }),
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
