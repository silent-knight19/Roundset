import { KokoroTTS } from 'kokoro-js';

export type KokoroDevice = 'webgpu' | 'wasm';

export interface TTSOutput {
  blob: Blob;
  device: KokoroDevice;
  modelLoadMs: number;
}

export interface ActiveAudio {
  player: HTMLAudioElement;
  url: string;
}

let loadedModel: KokoroTTS | null = null;
let initializingPromise: Promise<{
  tts: KokoroTTS;
  device: KokoroDevice;
}> | null = null;
let activeDevice: KokoroDevice = 'wasm';

export function getActiveKokoroDevice(): string {
  if (!loadedModel) return 'not loaded';
  return activeDevice;
}

export async function initializeKokoro(): Promise<{
  tts: KokoroTTS;
  device: KokoroDevice;
}> {
  if (loadedModel) {
    return { tts: loadedModel, device: activeDevice };
  }

  if (initializingPromise) {
    return initializingPromise;
  }

  initializingPromise = (async () => {
    const hasWebGPU =
      typeof navigator !== 'undefined' &&
      Boolean((navigator as Navigator & { gpu?: unknown }).gpu);

    if (hasWebGPU) {
      try {
        const tts = await KokoroTTS.from_pretrained(
          'onnx-community/Kokoro-82M-v1.0-ONNX',
          {
            device: 'webgpu',
            dtype: 'fp32',
          },
        );
        activeDevice = 'webgpu';
        loadedModel = tts;
        return { tts, device: activeDevice };
      } catch (error) {
        console.warn('WebGPU Kokoro initialization failed; falling back to WASM.', error);
      }
    }

    const tts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      {
        device: 'wasm',
        dtype: 'q8',
      },
    );
    activeDevice = 'wasm';
    loadedModel = tts;
    return { tts, device: activeDevice };
  })();

  try {
    return await initializingPromise;
  } finally {
    initializingPromise = null;
  }
}

export async function synthesizeKokoro(
  text: string,
  voice: string,
): Promise<TTSOutput> {
  const start = performance.now();
  const { tts, device } = await initializeKokoro();
  const modelLoadMs = performance.now() - start;

  // The kokoro-js library types voice as a union of specific strings
  const audio = await tts.generate(text, {
    voice: voice as Parameters<KokoroTTS['generate']>[1] extends { voice?: infer V }
      ? V
      : never,
  });
  const blob = audio.toBlob();
  return { blob, device, modelLoadMs };
}

export function cancelAudio(active: ActiveAudio | null): void {
  if (!active) return;
  try {
    active.player.onended = null;
    active.player.onerror = null;
    active.player.onplaying = null;
    active.player.pause();
    active.player.src = '';
  } catch {
    // noop
  }
  try {
    URL.revokeObjectURL(active.url);
  } catch {
    // noop
  }
}

export function playAudioBlob(
  blob: Blob,
  callbacks?: {
    onPlaying?: () => void;
    onEnded?: () => void;
    onError?: (error: unknown) => void;
  },
): ActiveAudio {
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);

  if (callbacks?.onPlaying) {
    player.onplaying = () => {
      callbacks.onPlaying?.();
    };
  }

  if (callbacks?.onEnded) {
    player.onended = () => {
      cancelAudio({ player, url });
      callbacks.onEnded?.();
    };
  }

  if (callbacks?.onError) {
    player.onerror = (e) => {
      cancelAudio({ player, url });
      callbacks.onError?.(e);
    };
  }

  player.play().catch((err) => {
    callbacks?.onError?.(err);
  });

  return { player, url };
}

export function resetKokoroStateForTesting(): void {
  loadedModel = null;
  initializingPromise = null;
  activeDevice = 'wasm';
}
