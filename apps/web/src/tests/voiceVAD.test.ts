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

describe('VADAdapter (Silero VAD Web Adapter - R1 Lifecycle & Race Invalidation)', () => {
  let mockVADInstance: {
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockVADInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(MicVAD.new).mockResolvedValue(
      mockVADInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>,
    );
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

    await adapter.start();
    expect(mockVADInstance.start).toHaveBeenCalled();
    expect(adapter.getStatus().isRunning).toBe(true);
    expect(adapter.getStatus().hasInstance).toBe(true);
  });

  it('handles VAD initialization failure gracefully (Requirement 3)', async () => {
    vi.mocked(MicVAD.new).mockRejectedValueOnce(
      new Error('Microphone permission denied (NotAllowedError)'),
    );

    const adapter = new VADAdapter();
    await expect(adapter.initialize()).rejects.toThrow('NotAllowedError');

    expect(adapter.getStatus().isRunning).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(false);
    expect(adapter.getStatus().isInitializing).toBe(false);
  });

  it('cleans up and destroys existing VAD instance before re-initializing (R1)', async () => {
    const firstInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const secondInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(MicVAD.new)
      .mockResolvedValueOnce(firstInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>)
      .mockResolvedValueOnce(secondInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>);

    const adapter = new VADAdapter();
    await adapter.initialize();
    await adapter.start();

    // Call initialize second time
    await adapter.initialize();
    expect(firstInstance.destroy).toHaveBeenCalled();
    expect(adapter.getStatus().hasInstance).toBe(true);
  });

  it('supports pause for temporary suspension without permanently destroying detector (R1)', async () => {
    const adapter = new VADAdapter();
    await adapter.initialize();
    await adapter.start();
    expect(adapter.getStatus().isRunning).toBe(true);

    await adapter.pause();
    expect(mockVADInstance.pause).toHaveBeenCalledTimes(1);
    expect(mockVADInstance.destroy).not.toHaveBeenCalled();
    expect(adapter.getStatus().isRunning).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(true);
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
    await adapter.start();
    capturedOptions?.onSpeechStart?.();
    capturedOptions?.onSpeechEnd?.(new Float32Array());
    capturedOptions?.onVADMisfire?.();

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
    expect(onVADMisfire).toHaveBeenCalledTimes(1);
  });

  it('disposes newly resolved detector immediately if initialization completed after destroy (R1 Stale Resolution)', async () => {
    let resolvePendingVAD: (inst: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolvePendingVAD = resolve;
    });

    vi.mocked(MicVAD.new).mockReturnValueOnce(
      pendingPromise as unknown as ReturnType<typeof MicVAD.new>,
    );

    const staleInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new VADAdapter();
    const initPromise = adapter.initialize();
    expect(adapter.getStatus().isInitializing).toBe(true);

    // Call destroy while initialization is still pending in-flight
    await adapter.destroy();
    expect(adapter.getStatus().isInitializing).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(false);

    // Late resolution occurs
    resolvePendingVAD(staleInstance);
    const result = await initPromise;

    // Initialization returned false because session was invalidated
    expect(result).toBe(false);
    // Stale detector must be immediately destroyed and not retained
    expect(staleInstance.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().hasInstance).toBe(false);
  });

  it('disposes newly resolved detector if superseded by a newer initialize call (R1 Multiple Sessions)', async () => {
    let resolveFirst: (inst: unknown) => void = () => {};
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const firstInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const secondInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(MicVAD.new)
      .mockReturnValueOnce(firstPromise as unknown as ReturnType<typeof MicVAD.new>)
      .mockResolvedValueOnce(secondInstance as unknown as Awaited<ReturnType<typeof MicVAD.new>>);

    const adapter = new VADAdapter();
    const firstInitPromise = adapter.initialize();

    // Start second initialization while first is still pending
    const secondInitPromise = adapter.initialize();
    const secondResult = await secondInitPromise;
    expect(secondResult).toBe(true);

    // Resolve first initialization late
    resolveFirst(firstInstance);
    const firstResult = await firstInitPromise;

    expect(firstResult).toBe(false);
    expect(firstInstance.destroy).toHaveBeenCalledTimes(1);
    expect(secondInstance.destroy).not.toHaveBeenCalled();
    expect(adapter.getStatus().hasInstance).toBe(true);
  });

  it('cleans up and releases microphone processing completely via destroy (R1)', async () => {
    const adapter = new VADAdapter();
    await adapter.initialize();
    await adapter.start();

    await adapter.cleanup();
    expect(mockVADInstance.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().isRunning).toBe(false);
    expect(adapter.getStatus().hasInstance).toBe(false);
  });

  describe('R2-01 & R2-02: Scoped Destruction and Reliable Start Activation Reporting', () => {
    it('returns true from start() when detector starts successfully (R2-02)', async () => {
      const adapter = new VADAdapter();
      await adapter.initialize();

      const started = await adapter.start();
      expect(started).toBe(true);
      expect(adapter.getStatus().isRunning).toBe(true);
      expect(mockVADInstance.start).toHaveBeenCalledTimes(1);
    });

    it('returns false and destroys failed detector when detector.start() throws synchronously (R2-02)', async () => {
      mockVADInstance.start.mockImplementationOnce(() => {
        throw new Error('AudioContext failed to start synchronously');
      });

      const adapter = new VADAdapter();
      await adapter.initialize();

      const started = await adapter.start();
      expect(started).toBe(false);
      expect(adapter.getStatus().isRunning).toBe(false);
      expect(adapter.getStatus().hasInstance).toBe(false);
      expect(mockVADInstance.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns false and destroys failed detector when detector.start() rejects asynchronously (R2-02)', async () => {
      mockVADInstance.start.mockRejectedValueOnce(
        new Error('Asynchronous audio pipeline startup failure'),
      );

      const adapter = new VADAdapter();
      await adapter.initialize();

      const started = await adapter.start();
      expect(started).toBe(false);
      expect(adapter.getStatus().isRunning).toBe(false);
      expect(adapter.getStatus().hasInstance).toBe(false);
      expect(mockVADInstance.destroy).toHaveBeenCalledTimes(1);
    });

    it('does not destroy new detector when scoped destroy(olderGen) is invoked from obsolete session (R2-01)', async () => {
      const detectorA = {
        start: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
      };
      const detectorB = {
        start: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(MicVAD.new)
        .mockResolvedValueOnce(detectorA as unknown as Awaited<ReturnType<typeof MicVAD.new>>)
        .mockResolvedValueOnce(detectorB as unknown as Awaited<ReturnType<typeof MicVAD.new>>);

      const adapter = new VADAdapter();
      await adapter.initialize();
      const genA = adapter.getStatus().generation;

      // Initialize session B
      await adapter.initialize();
      const genB = adapter.getStatus().generation;
      expect(genB).toBeGreaterThan(genA);
      expect(detectorA.destroy).toHaveBeenCalledTimes(1); // detectorA was cleanly destroyed during initialize B

      // Session A calls scoped destroy(genA) late
      await adapter.destroy(genA);

      // Detector B must NOT be destroyed
      expect(detectorB.destroy).not.toHaveBeenCalled();
      expect(adapter.getStatus().hasInstance).toBe(true);

      // Scoped destroy for genB properly disposes detector B
      await adapter.destroy(genB);
      expect(detectorB.destroy).toHaveBeenCalledTimes(1);
      expect(adapter.getStatus().hasInstance).toBe(false);
    });

    it('returns false from start(olderGen) if generation is already superseded (R2-02)', async () => {
      const adapter = new VADAdapter();
      await adapter.initialize();
      const genA = adapter.getStatus().generation;

      await adapter.initialize(); // Advances generation to B

      const started = await adapter.start(genA);
      expect(started).toBe(false);
      expect(adapter.getStatus().isRunning).toBe(false);
    });
  });
});
