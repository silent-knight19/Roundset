import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSpeechRecognitionSupported,
  createBrowserSpeechRecognition,
  combineRecognitionResults,
  VoiceRecognitionAdapter,
  type BrowserSpeechRecognition,
} from '../lib/voice/recognition';

describe('VoiceRecognitionAdapter and Speech Recognition Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Browser Support (Requirement 1)', () => {
    it('detects supported browser when SpeechRecognition is present', () => {
      function MockSpeechRecognition() {}
      vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
      expect(isSpeechRecognitionSupported()).toBe(true);
    });

    it('detects supported browser when webkitSpeechRecognition is present', () => {
      function MockWebKitSpeechRecognition() {}
      vi.stubGlobal('window', { webkitSpeechRecognition: MockWebKitSpeechRecognition });
      expect(isSpeechRecognitionSupported()).toBe(true);
    });

    it('detects unsupported browser when neither API is present', () => {
      vi.stubGlobal('window', {});
      expect(isSpeechRecognitionSupported()).toBe(false);
      expect(createBrowserSpeechRecognition()).toBeNull();
    });

    it('returns null if creating recognition constructor throws', () => {
      function ThrowingRecognition() {
        throw new Error('Constructor blocked');
      }
      vi.stubGlobal('window', { SpeechRecognition: ThrowingRecognition });
      expect(createBrowserSpeechRecognition()).toBeNull();
    });
  });

  describe('Transcript Combining', () => {
    it('combines final and interim results properly', () => {
      const results = [
        { isFinal: true, length: 1, 0: { transcript: 'Hello' } },
        { isFinal: false, length: 1, 0: { transcript: 'world' } },
      ];
      const combined = combineRecognitionResults(results);
      expect(combined.final).toBe('Hello');
      expect(combined.interim).toBe('world');
      expect(combined.display).toBe('Hello world');
    });

    it('handles empty results and whitespace gracefully', () => {
      const results = [
        { isFinal: true, length: 1, 0: { transcript: '   ' } },
        { isFinal: false, length: 1, 0: { transcript: '' } },
      ];
      const combined = combineRecognitionResults(results);
      expect(combined.final).toBe('');
      expect(combined.interim).toBe('');
      expect(combined.display).toBe('');
    });
  });

  describe('Adapter Lifecycle & Permission Handling (Requirement 2 & 12)', () => {
    let mockInstance: BrowserSpeechRecognition;

    beforeEach(() => {
      mockInstance = {
        continuous: false,
        interimResults: false,
        lang: 'en-US',
        onstart: null,
        onend: null,
        onerror: null,
        onresult: null,
        start: vi.fn(),
        stop: vi.fn(),
        abort: vi.fn(),
      };

      function MockRecognitionConstructor() {
        return mockInstance;
      }

      vi.stubGlobal('window', {
        SpeechRecognition: MockRecognitionConstructor,
      });
    });

    it('initializes and binds events correctly', () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const onTranscript = vi.fn();
      const adapter = new VoiceRecognitionAdapter({ onStart, onEnd, onTranscript });

      const initialized = adapter.initialize({ lang: 'en-IN' });
      expect(initialized).toBe(true);
      expect(mockInstance.continuous).toBe(true);
      expect(mockInstance.interimResults).toBe(true);
      expect(mockInstance.lang).toBe('en-IN');

      mockInstance.onstart?.();
      expect(onStart).toHaveBeenCalled();
      expect(adapter.getStatus().isBusy).toBe(true);

      mockInstance.onresult?.({
        results: [{ isFinal: true, length: 1, 0: { transcript: 'test transcript' } }],
      });
      expect(onTranscript).toHaveBeenCalledWith({
        final: 'test transcript',
        interim: '',
        display: 'test transcript',
      });

      mockInstance.onend?.();
      expect(onEnd).toHaveBeenCalled();
      expect(adapter.getStatus().isBusy).toBe(false);
    });

    it('handles microphone permission denial (not-allowed / service-not-allowed)', () => {
      const onError = vi.fn();
      const adapter = new VoiceRecognitionAdapter({ onError });
      adapter.initialize();
      adapter.start();

      mockInstance.onerror?.({ error: 'not-allowed' });

      expect(onError).toHaveBeenCalledWith('not-allowed', true);
      expect(adapter.getStatus().isWanted).toBe(false);
      expect(adapter.getStatus().isBusy).toBe(false);
    });

    it('restarts recognition on unexpected onend if still wanted', () => {
      const adapter = new VoiceRecognitionAdapter();
      adapter.initialize();
      adapter.start();

      mockInstance.onstart?.();
      expect(adapter.getStatus().isBusy).toBe(true);

      mockInstance.onend?.();
      expect(adapter.getStatus().isBusy).toBe(false);

      vi.advanceTimersByTime(350);
      expect(mockInstance.start).toHaveBeenCalledTimes(2);
    });

    it('stop(flush = true) calls recognition.stop() while stop(false) calls recognition.abort()', () => {
      const adapter = new VoiceRecognitionAdapter();
      adapter.initialize();
      adapter.start();
      mockInstance.onstart?.();

      adapter.stop(true);
      expect(mockInstance.stop).toHaveBeenCalled();

      adapter.start();
      mockInstance.onstart?.();
      adapter.stop(false);
      expect(mockInstance.abort).toHaveBeenCalled();
    });

    it('cleanup completely tears down recognition instance and listeners', () => {
      const adapter = new VoiceRecognitionAdapter();
      adapter.initialize();
      adapter.cleanup();

      expect(mockInstance.abort).toHaveBeenCalled();
      expect(mockInstance.onstart).toBeNull();
      expect(mockInstance.onend).toBeNull();
      expect(mockInstance.onerror).toBeNull();
      expect(mockInstance.onresult).toBeNull();
      expect(adapter.getStatus().hasInstance).toBe(false);
    });
  });
});
