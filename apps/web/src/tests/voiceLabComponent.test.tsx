// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../lib/voice/tts', () => ({
  synthesizeKokoro: vi.fn(),
  getActiveKokoroDevice: vi.fn().mockReturnValue('wasm'),
  cancelAudio: vi.fn(),
  playAudioBlob: vi.fn(),
  initializeKokoro: vi.fn(),
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: vi.fn() },
}));

import { VoiceLabPage } from '../pages/dev/VoiceLabPage';
import { ConversationController } from '../lib/voice/conversationController';
import * as recognitionModule from '../lib/voice/recognition';

describe('VoiceLabPage Component (Laboratory UI & Unmount Safety - R3, R5)', () => {
  let mockControllerInstance: {
    startSession: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
    manualInterrupt: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    setVoice: ReturnType<typeof vi.fn>;
    updateDraft: ReturnType<typeof vi.fn>;
    submitAnswer: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.spyOn(recognitionModule, 'isSpeechRecognitionSupported').mockReturnValue(true);

    mockControllerInstance = {
      startSession: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn(),
      manualInterrupt: vi.fn(),
      reset: vi.fn(),
      setVoice: vi.fn(),
      updateDraft: vi.fn(),
      submitAnswer: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
      getState: vi.fn().mockReturnValue({
        stage: 'idle',
        status: 'Ready to start practice.',
        voice: 'af_heart',
        inputMode: 'voice',
        draft: '',
        messages: [],
        interruptedCount: 0,
        latencyMs: null,
        vadSpeech: false,
        microphoneActive: false,
        modelDevice: 'wasm',
        eventLog: [],
      }),
    };

    vi.spyOn(ConversationController.prototype, 'startSession').mockImplementation(
      mockControllerInstance.startSession as () => Promise<void>,
    );
    vi.spyOn(ConversationController.prototype, 'stopSession').mockImplementation(
      mockControllerInstance.stopSession as () => void,
    );
    vi.spyOn(ConversationController.prototype, 'manualInterrupt').mockImplementation(
      mockControllerInstance.manualInterrupt as () => void,
    );
    vi.spyOn(ConversationController.prototype, 'reset').mockImplementation(
      mockControllerInstance.reset as () => void,
    );
    vi.spyOn(ConversationController.prototype, 'setVoice').mockImplementation(
      mockControllerInstance.setVoice as (voice: string) => void,
    );
    vi.spyOn(ConversationController.prototype, 'updateDraft').mockImplementation(
      mockControllerInstance.updateDraft as (text: string) => void,
    );
    vi.spyOn(ConversationController.prototype, 'submitAnswer').mockImplementation(
      mockControllerInstance.submitAnswer as (text: string) => Promise<void>,
    );
    vi.spyOn(ConversationController.prototype, 'cleanup').mockImplementation(
      mockControllerInstance.cleanup as () => void,
    );
    vi.spyOn(ConversationController.prototype, 'getState').mockImplementation(
      mockControllerInstance.getState as () => ReturnType<ConversationController['getState']>,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders initial voice laboratory layout and diagnostics', () => {
    render(<VoiceLabPage />);

    expect(screen.getByText(/Natural Voice Conversation Lab/i)).toBeDefined();
    expect(screen.getByText(/Development Only/i)).toBeDefined();

    const startButton = screen.getByRole('button', { name: /▶ Start Interview/i });
    expect(startButton.hasAttribute('disabled')).toBe(false);

    const stopButton = screen.getByRole('button', { name: /■ Stop/i });
    expect(stopButton.hasAttribute('disabled')).toBe(true);

    expect(screen.getByText(/Pipeline Diagnostics/i)).toBeDefined();
  });

  it('verifies inert "Play Prepared" button is removed from UI (R5)', () => {
    render(<VoiceLabPage />);
    expect(screen.queryByRole('button', { name: /Play Prepared/i })).toBeNull();
  });

  it('triggers startSession when start button is clicked', () => {
    render(<VoiceLabPage />);
    const startButton = screen.getByRole('button', { name: /▶ Start Interview/i });
    fireEvent.click(startButton);

    expect(mockControllerInstance.startSession).toHaveBeenCalled();
  });

  it('triggers voice change on selection', () => {
    render(<VoiceLabPage />);
    const voiceSelect = screen.getByLabelText(/Kokoro Voice/i);
    fireEvent.change(voiceSelect, { target: { value: 'bm_george' } });

    expect(mockControllerInstance.setVoice).toHaveBeenCalledWith('bm_george');
  });

  it('allows typing manual answer and clicking send', () => {
    render(<VoiceLabPage />);
    const textarea = screen.getByPlaceholderText(
      /Spoken words will appear here in real time/i,
    );

    fireEvent.change(textarea, { target: { value: 'My manual answer' } });
    expect(mockControllerInstance.updateDraft).toHaveBeenCalledWith(
      'My manual answer',
    );
  });

  it('cleans up controller on component unmount (Requirement 10)', () => {
    const { unmount } = render(<VoiceLabPage />);
    unmount();

    expect(mockControllerInstance.cleanup).toHaveBeenCalled();
  });

  it('enables typed-only fallback when browser speech recognition is unsupported (R3)', () => {
    vi.spyOn(recognitionModule, 'isSpeechRecognitionSupported').mockReturnValue(false);
    render(<VoiceLabPage />);

    expect(
      screen.getByText(/Browser speech recognition is not supported in this browser/i),
    ).toBeDefined();
    expect(screen.getByText(/Typed-Only Fallback/i)).toBeDefined();

    // Start button remains enabled so candidate can still practice with Kokoro TTS and typed input
    const startButton = screen.getByRole('button', { name: /▶ Start Interview/i });
    expect(startButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(startButton);
    expect(mockControllerInstance.startSession).toHaveBeenCalledTimes(1);
  });
});
