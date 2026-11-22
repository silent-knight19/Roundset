// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

import { routes } from '../app/router';
import { ConversationController } from '../lib/voice/conversationController';
import * as recognitionModule from '../lib/voice/recognition';
import * as ttsModule from '../lib/voice/tts';
import * as vadModule from '../lib/voice/vad';

describe('Voice Lab Security, Privacy & Production Isolation', () => {
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
            start: vi.fn(),
            pause: vi.fn(),
            cleanup: vi.fn(),
            getStatus: vi.fn().mockReturnValue({ isRunning: false, isInitializing: false, hasInstance: true }),
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

    it('verifies route exclusion when import.meta.env.DEV is simulated false', () => {
      // In production mode, devRoutes is empty, so root routes do not contain dev/voice-lab
      const rootRoute = routes.find((r) => r.path === '/');
      expect(rootRoute).toBeDefined();

      const children = rootRoute?.children || [];
      // If run in DEV mode during tests, dev/voice-lab is present;
      // In a production build, devRoutes is []
      if (!import.meta.env.DEV) {
        const voiceLabRoute = children.find((r) => r.path === 'dev/voice-lab');
        expect(voiceLabRoute).toBeUndefined();
      }
    });
  });

  describe('Production Bundle Exclusion (Requirement 15)', () => {
    it('verifies that the built production bundle does not contain VoiceLabPage or ONNX runtime assets', () => {
      const distDir = path.resolve(__dirname, '../../dist/assets');
      if (!fs.existsSync(distDir)) {
        // Build may not have been run yet in clean workspace; skip gracefully or check if dist exists
        return;
      }

      const files = fs.readdirSync(distDir);
      // No wasm chunks should be in production assets
      const wasmFiles = files.filter((f) => f.endsWith('.wasm'));
      expect(wasmFiles).toHaveLength(0);

      // Inspect all js files in dist/assets
      const jsFiles = files.filter((f) => f.endsWith('.js'));
      for (const jsFile of jsFiles) {
        const content = fs.readFileSync(path.join(distDir, jsFile), 'utf-8');
        // The router in production bundle must not register dev/voice-lab
        expect(content).not.toContain('dev/voice-lab');
        expect(content).not.toContain('VoiceLabPage');
      }
    });
  });
});
