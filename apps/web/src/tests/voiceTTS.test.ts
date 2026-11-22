import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initializeKokoro,
  synthesizeKokoro,
  cancelAudio,
  playAudioBlob,
  getActiveKokoroDevice,
  resetKokoroStateForTesting,
  type ActiveAudio,
} from '../lib/voice/tts';
import { KokoroTTS } from 'kokoro-js';

vi.mock('kokoro-js', () => {
  return {
    KokoroTTS: {
      from_pretrained: vi.fn(),
    },
  };
});

describe('Kokoro TTS Adapter (Local Speech Synthesis)', () => {
  let mockTTSInstance: {
    generate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetKokoroStateForTesting();
    mockTTSInstance = {
      generate: vi.fn().mockResolvedValue({
        toBlob: () => new Blob(['fake-audio-bytes'], { type: 'audio/wav' }),
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes WebGPU-first when WebGPU is available', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValueOnce(
      mockTTSInstance as unknown as KokoroTTS,
    );

    const result = await initializeKokoro();

    expect(result.device).toBe('webgpu');
    expect(getActiveKokoroDevice()).toBe('webgpu');
    expect(KokoroTTS.from_pretrained).toHaveBeenCalledWith(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        device: 'webgpu',
        dtype: 'fp32',
      },
    );
  });

  it('falls back to WASM when WebGPU initialization throws (Requirement 4)', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    vi.mocked(KokoroTTS.from_pretrained)
      .mockRejectedValueOnce(new Error('WebGPU adapter not found'))
      .mockResolvedValueOnce(mockTTSInstance as unknown as KokoroTTS);

    const result = await initializeKokoro();

    expect(result.device).toBe('wasm');
    expect(getActiveKokoroDevice()).toBe('wasm');
    expect(KokoroTTS.from_pretrained).toHaveBeenCalledTimes(2);
    expect(KokoroTTS.from_pretrained).toHaveBeenLastCalledWith(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        device: 'wasm',
        dtype: 'q8',
      },
    );
  });

  it('initializes WASM directly when WebGPU is absent', async () => {
    vi.stubGlobal('navigator', {});
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValueOnce(
      mockTTSInstance as unknown as KokoroTTS,
    );

    const result = await initializeKokoro();
    expect(result.device).toBe('wasm');
    expect(KokoroTTS.from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('handles total Kokoro initialization failure (Requirement 4)', async () => {
    vi.stubGlobal('navigator', {});
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValueOnce(
      new Error('Failed to fetch ONNX model from Hugging Face'),
    );

    await expect(initializeKokoro()).rejects.toThrow('Failed to fetch ONNX model');
    expect(getActiveKokoroDevice()).toBe('not loaded');
  });

  it('reuses loaded model across subsequent syntheses without re-fetching', async () => {
    vi.stubGlobal('navigator', {});
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue(
      mockTTSInstance as unknown as KokoroTTS,
    );

    const output1 = await synthesizeKokoro('First line', 'af_heart');
    expect(output1.device).toBe('wasm');
    expect(KokoroTTS.from_pretrained).toHaveBeenCalledTimes(1);

    const output2 = await synthesizeKokoro('Second line', 'af_heart');
    expect(output2.device).toBe('wasm');
    // Model is reused, not re-fetched
    expect(KokoroTTS.from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('cancelAudio stops playback, removes listeners, resets src and revokes URL', () => {
    const mockAudio: ActiveAudio = {
      player: {
        pause: vi.fn(),
        onended: vi.fn(),
        onerror: vi.fn(),
        onplaying: vi.fn(),
        src: 'blob:http://localhost/test-uuid',
      } as unknown as HTMLAudioElement,
      url: 'blob:http://localhost/test-uuid',
    };

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    cancelAudio(mockAudio);

    expect(mockAudio.player.pause).toHaveBeenCalled();
    expect(mockAudio.player.src).toBe('');
    expect(mockAudio.player.onended).toBeNull();
    expect(mockAudio.player.onerror).toBeNull();
    expect(mockAudio.player.onplaying).toBeNull();
    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/test-uuid');
  });

  it('playAudioBlob plays audio and invokes callbacks', () => {
    const mockPlay = vi.fn().mockResolvedValue(undefined);
    const mockPause = vi.fn();

    vi.stubGlobal('Audio', function (this: HTMLAudioElement, src: string) {
      this.src = src;
      this.play = mockPlay;
      this.pause = mockPause;
      return this;
    });

    const onPlaying = vi.fn();
    const onEnded = vi.fn();

    const blob = new Blob(['sample'], { type: 'audio/wav' });
    const active = playAudioBlob(blob, { onPlaying, onEnded });

    expect(mockPlay).toHaveBeenCalled();
    expect(active.url).toBeDefined();

    active.player.onplaying?.(new Event('playing'));
    expect(onPlaying).toHaveBeenCalled();

    active.player.onended?.(new Event('ended'));
    expect(onEnded).toHaveBeenCalled();
    expect(mockPause).toHaveBeenCalled();
  });
});
