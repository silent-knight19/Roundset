// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../lib/voice/tts', () => ({
  synthesizeKokoro: vi.fn().mockResolvedValue({
    blob: new Blob(['audio']),
    device: 'wasm',
    modelLoadMs: 20,
  }),
  getActiveKokoroDevice: vi.fn().mockReturnValue('wasm'),
  cancelAudio: vi.fn(),
  playAudioBlob: vi.fn().mockReturnValue({
    player: {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    },
    url: 'blob:test-audio',
  }),
  initializeKokoro: vi.fn(),
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: vi.fn() },
}));

import { ConversationController } from '../lib/voice/conversationController';
import * as recognitionModule from '../lib/voice/recognition';
import * as ttsModule from '../lib/voice/tts';
import * as vadModule from '../lib/voice/vad';

describe('Voice Lab Security, Privacy & Production Isolation (R4)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe('Storage Non-Pollution & Privacy (Requirement 13 & Section 6)', () => {
    it('does not write transcripts, audio, or tokens to localStorage or sessionStorage during conversation', async () => {
      vi.spyOn(recognitionModule, 'isSpeechRecognitionSupported').mockReturnValue(true);
      vi.spyOn(recognitionModule, 'VoiceRecognitionAdapter').mockImplementation(
        function (this: unknown, cbs?: recognitionModule.VoiceRecognitionCallbacks) {
          return {
            initialize: vi.fn().mockReturnValue(true),
            start: vi.fn(),
            stop: vi.fn(),
            cleanup: vi.fn(),
            getStatus: vi.fn().mockReturnValue({ isBusy: false, isWanted: false, hasInstance: true }),
            callbacks: cbs,
          } as unknown as recognitionModule.VoiceRecognitionAdapter;
        },
      );

      vi.spyOn(vadModule, 'VADAdapter').mockImplementation(
        function (this: unknown, cbs?: vadModule.VADCallbacks) {
          return {
            initialize: vi.fn().mockResolvedValue(true),
            start: vi.fn().mockResolvedValue(undefined),
            pause: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn().mockResolvedValue(undefined),
            cleanup: vi.fn().mockResolvedValue(undefined),
            getStatus: vi.fn().mockReturnValue({ isRunning: false, isInitializing: false, hasInstance: true, generation: 1 }),
            callbacks: cbs,
          } as unknown as vadModule.VADAdapter;
        },
      );

      vi.spyOn(ttsModule, 'synthesizeKokoro').mockResolvedValue({
        blob: new Blob(['audio']),
        device: 'wasm',
        modelLoadMs: 20,
      });

      vi.spyOn(ttsModule, 'playAudioBlob').mockReturnValue({
        player: {
          pause: vi.fn(),
          play: vi.fn().mockResolvedValue(undefined),
        } as unknown as HTMLAudioElement,
        url: 'blob:test-audio',
      });

      const controller = new ConversationController();
      await controller.startSession();

      // Submit an answer
      await controller.submitAnswer('This is a sensitive practice answer');

      // Interrupt AI
      controller.manualInterrupt();

      // Stop session
      controller.stopSession();

      // Assert zero entries in web storage
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(localStorage.getItem('transcript')).toBeNull();
      expect(sessionStorage.getItem('transcript')).toBeNull();
      expect(localStorage.getItem('token')).toBeNull();
      expect(sessionStorage.getItem('token')).toBeNull();
    });
  });

  describe('Route Isolation & Public Navigation (Requirement 14 & Section 4)', () => {
    it('does not include public navigation links to /dev/voice-lab in AppLayout', () => {
      const appLayoutContent = fs.readFileSync(
        path.resolve(__dirname, '../components/AppLayout.tsx'),
        'utf-8',
      );
      expect(appLayoutContent).not.toContain('dev/voice-lab');
      expect(appLayoutContent).not.toContain('Voice Lab');
    });

    it('does not modify the production /interview workflow', () => {
      const interviewPageContent = fs.readFileSync(
        path.resolve(__dirname, '../pages/InterviewPage.tsx'),
        'utf-8',
      );
      expect(interviewPageContent).not.toContain('dev/voice-lab');
      expect(interviewPageContent).not.toContain('ConversationController');
    });

    it('verifies router source guarantees dev-only gate for /dev/voice-lab', () => {
      const routerSource = fs.readFileSync(
        path.resolve(__dirname, '../app/router.tsx'),
        'utf-8',
      );
      expect(routerSource).toContain('import.meta.env.DEV');
      expect(routerSource).toContain("'dev/voice-lab'");
    });
  });

  describe('Fail-Closed Production Bundle Exclusion (Requirement 15 & R4)', () => {
    it('asserts that emitted production bundles exist and contain no laboratory routes or assets', () => {
      const distDir = path.resolve(__dirname, '../../dist/assets');
      if (!fs.existsSync(distDir)) {
        // Execute build synchronously to guarantee fail-closed verification
        execSync('npm run build', {
          cwd: path.resolve(__dirname, '../../..'),
          stdio: 'pipe',
        });
      }

      expect(fs.existsSync(distDir)).toBe(true);

      const files = fs.readdirSync(distDir);
      expect(files.length).toBeGreaterThan(0);

      // 1. Assert zero WASM binaries in client dist/assets
      const wasmFiles = files.filter((f) => f.endsWith('.wasm'));
      expect(wasmFiles).toHaveLength(0);

      // 2. Inspect all js chunks
      const jsFiles = files.filter((f) => f.endsWith('.js'));
      expect(jsFiles.length).toBeGreaterThan(0);

      for (const jsFile of jsFiles) {
        const content = fs.readFileSync(path.join(distDir, jsFile), 'utf-8');
        expect(content).not.toContain('dev/voice-lab');
        expect(content).not.toContain('VoiceLabPage');
      }
    });
  });
});
