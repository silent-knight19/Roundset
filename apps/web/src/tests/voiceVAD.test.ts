import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VADAdapter } from '../lib/voice/vad';
import { MicVAD } from '@ricky0123/vad-web';

vi.mock('@ricky0123/vad-web', () => {
  return {
    MicVAD: {
      new: vi.fn(),
    },
  };
});

describe('VADAdapter (Silero VAD Web Adapter)', () => {
  let mockVADInstance: {
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy?: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockVADInstance = {
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    };
    vi.mocked(MicVAD.new).mockResolvedValue(mockVADInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with pinned asset paths and starts detector', async () => {
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const onVADMisfire = vi.fn();

    const adapter = new VADAdapter({ onSpeechStart, onSpeechEnd, onVADMisfire });
    const success = await adapter.initialize();

    expect(success).toBe(true);
    expect(MicVAD.new).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'v6',
        baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/',
        onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
      }),
    );

    adapter.start();
    expect(mockVADInstance.start).toHaveBeenCalled();
    expect(adapter.getStatus().isRunning).toBe(true);
  });

  it('handles VAD initialization failure gracefully (Requirement 3)', async () => {
    vi.mocked(MicVAD.new).mockRejectedValueOnce(new Error('Microphone permission denied (NotAllowedError)'));

    const adapter = new VADAdapter();
    await expect(adapter.initialize()).rejects.toThrow('NotAllowedError');

    expect(adapter.getStatus().isRunning).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(false);
    expect(adapter.getStatus().isInitializing).toBe(false);
  });

  it('cleans up existing VAD instance before re-initializing (Requirement 12)', async () => {
    const adapter = new VADAdapter();
    await adapter.initialize();
    adapter.start();

    // Call initialize second time
    await adapter.initialize();
    expect(mockVADInstance.pause).toHaveBeenCalled();
  });

  it('executes speech callbacks only when running', async () => {
    let capturedOptions: Parameters<typeof MicVAD.new>[0] | undefined;
    vi.mocked(MicVAD.new).mockImplementationOnce(async (options) => {
      capturedOptions = options;
      return mockVADInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>;
    });

    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const onVADMisfire = vi.fn();

    const adapter = new VADAdapter({ onSpeechStart, onSpeechEnd, onVADMisfire });
    await adapter.initialize();

    // Not started yet: speech callbacks should be guarded
    capturedOptions?.onSpeechStart?.();
    capturedOptions?.onSpeechEnd?.(new Float32Array());
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(onSpeechEnd).not.toHaveBeenCalled();

    // Now start
    adapter.start();
    capturedOptions?.onSpeechStart?.();
    capturedOptions?.onSpeechEnd?.(new Float32Array());
    capturedOptions?.onVADMisfire?.();

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(onVADMisfire).toHaveBeenCalledTimes(1);
  });

  it('cleans up and releases microphone processing completely', async () => {
    const adapter = new VADAdapter();
    await adapter.initialize();
    adapter.start();

    adapter.cleanup();
    expect(mockVADInstance.pause).toHaveBeenCalled();
    expect(adapter.getStatus().isRunning).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(false);
  });
});
