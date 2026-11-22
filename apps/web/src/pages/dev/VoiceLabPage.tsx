import React, { useEffect, useRef, useState } from 'react';
import {
  ConversationController,
  VOICE_STAGE_LABELS,
  type VoiceControllerState,
} from '../../lib/voice/conversationController';
import { isSpeechRecognitionSupported } from '../../lib/voice/recognition';

export function VoiceLabPage() {
  const controllerRef = useRef<ConversationController | null>(null);
  const [controllerState, setControllerState] = useState<VoiceControllerState>({
    stage: 'idle',
    status:
      'Desktop Chrome or Edge recommended. External network required on first load for models. Wear headphones for interruptions.',
    voice: 'af_heart',
    inputMode: 'voice',
    draft: '',
    messages: [],
    interruptedCount: 0,
    latencyMs: null,
    vadSpeech: false,
    microphoneActive: false,
    modelDevice: 'not loaded',
    eventLog: [],
  });

  const speechSupported = isSpeechRecognitionSupported();

  useEffect(() => {
    const controller = new ConversationController({
      onStateChange: (nextState) => {
        setControllerState(nextState);
      },
    });
    controllerRef.current = controller;
    setControllerState(controller.getState());

    return () => {
      controller.cleanup();
      controllerRef.current = null;
    };
  }, []);

  const {
    stage,
    status,
    voice,
    inputMode,
    draft,
    messages,
    interruptedCount,
    latencyMs,
    vadSpeech,
    microphoneActive,
    modelDevice,
    eventLog,
  } = controllerState;

  const isRunning = stage !== 'idle' && stage !== 'stopped' && stage !== 'error';

  const handleStart = () => {
    controllerRef.current?.startSession();
  };

  const handleStop = () => {
    controllerRef.current?.stopSession();
  };

  const handleManualInterrupt = () => {
    controllerRef.current?.manualInterrupt();
  };

  const handleReset = () => {
    controllerRef.current?.reset();
  };

  const handleVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    controllerRef.current?.setVoice(e.target.value);
  };

  const handleDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    controllerRef.current?.updateDraft(e.target.value);
  };

  const handleManualSend = () => {
    if (draft.trim()) {
      controllerRef.current?.submitAnswer(draft);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {/* Dev-only notice banner */}
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-500 text-slate-900 tracking-wide uppercase">
            Development Only
          </span>
          <span className="text-sm font-medium text-amber-900">
            Isolated Voice Conversation Laboratory (P5-VOI-01a) — Excluded from production builds
          </span>
        </div>
        <span className="text-xs text-amber-700/80">
          Scripted demonstration, not real AI · Initial model downloads require internet
        </span>
      </div>

      {/* Header */}
      <header className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider text-blue-600 uppercase mb-1">
              <span>●</span> Scripted Voice Pipeline Prototype
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Natural Voice Conversation Lab
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Test local Kokoro TTS synthesis, Silero speech activity detection, natural turn-taking, and user-initiated barge-in interruptions.
            </p>
          </div>
        </div>
      </header>

      {/* Toolbar & Controls */}
      <section
        aria-label="Voice Controls"
        className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label htmlFor="mode-select" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Interviewer Logic
            </label>
            <select
              id="mode-select"
              value="demo"
              disabled
              className="w-full text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 cursor-not-allowed"
            >
              <option value="demo">Scripted Demo (Local rule-based · No API key)</option>
            </select>
          </div>

          <div>
            <label htmlFor="voice-select" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
              Kokoro Voice
            </label>
            <select
              id="voice-select"
              value={voice}
              onChange={handleVoiceChange}
              disabled={isRunning}
              className="w-full text-sm bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-50 disabled:cursor-not-allowed"
            >
              <option value="af_heart">af_heart (Female · Heart)</option>
              <option value="af_bella">af_bella (Female · Bella)</option>
              <option value="am_michael">am_michael (Male · Michael)</option>
              <option value="bm_george">bm_george (Male · George)</option>
            </select>
          </div>

          <div className="sm:col-span-2 flex items-end gap-2">
            <button
              type="button"
              onClick={handleStart}
              disabled={isRunning}
              className="flex-1 bg-blue-600 text-white font-medium text-sm py-2 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
            >
              ▶ Start Interview
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={!isRunning}
              className="bg-rose-600 text-white font-medium text-sm py-2 px-4 rounded-lg hover:bg-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-600 focus:ring-offset-2 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
            >
              ■ Stop
            </button>
            <button
              type="button"
              onClick={handleManualInterrupt}
              disabled={stage !== 'speaking' && stage !== 'generating'}
              className="bg-amber-500 text-slate-900 font-medium text-sm py-2 px-3 rounded-lg hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              ↳ Interrupt AI
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="bg-slate-100 text-slate-700 font-medium text-sm py-2 px-3 rounded-lg hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-300 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        {!speechSupported && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs font-medium text-amber-800 flex items-center justify-between">
            <span>
              Browser speech recognition is not supported in this browser. You can still practice with Kokoro TTS audio and typed answers.
            </span>
            <span className="font-semibold text-amber-900 uppercase text-[10px] bg-amber-100 px-2 py-0.5 rounded">
              Typed-Only Fallback
            </span>
          </div>
        )}
      </section>

      {/* Main Grid: Conversation + Side Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Live Interview */}
        <section
          aria-label="Live Interview"
          className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6 shadow-xs flex flex-col space-y-6"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900">Live Conversation</h2>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                {inputMode === 'voice' ? 'Voice Mode' : 'Typed-Only Mode'}
              </span>
            </div>
            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold ${
                stage === 'speaking'
                  ? 'bg-blue-100 text-blue-800'
                  : stage === 'listening'
                  ? 'bg-emerald-100 text-emerald-800'
                  : stage === 'processing'
                  ? 'bg-purple-100 text-purple-800'
                  : stage === 'setup' || stage === 'generating'
                  ? 'bg-amber-100 text-amber-800'
                  : stage === 'error'
                  ? 'bg-rose-100 text-rose-800'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {VOICE_STAGE_LABELS[stage]}
            </span>
          </div>

          {/* Central Animated Indicator */}
          <div
            className="flex flex-col items-center justify-center p-8 bg-slate-50 border border-slate-100 rounded-xl text-center space-y-3"
            aria-label={`Current state: ${VOICE_STAGE_LABELS[stage]}`}
          >
            <div
              className={`w-20 h-20 rounded-full flex items-center justify-center text-2xl transition-all duration-300 ${
                vadSpeech
                  ? 'bg-emerald-500 text-white shadow-lg ring-4 ring-emerald-200 animate-pulse'
                  : stage === 'speaking'
                  ? 'bg-blue-600 text-white shadow-lg ring-4 ring-blue-200 animate-bounce'
                  : stage === 'listening'
                  ? 'bg-slate-200 text-slate-600'
                  : 'bg-slate-100 text-slate-400'
              }`}
            >
              {vadSpeech ? '◉' : stage === 'speaking' ? '≋' : inputMode === 'voice' ? '◎' : '⌨'}
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                {vadSpeech
                  ? 'Candidate Voice Detected'
                  : inputMode === 'typed_only'
                  ? stage === 'listening'
                    ? 'Awaiting Typed Answer'
                    : VOICE_STAGE_LABELS[stage]
                  : VOICE_STAGE_LABELS[stage]}
              </p>
              <p className="text-xs text-slate-500">
                {inputMode === 'typed_only'
                  ? 'Type your response below and click Send Answer'
                  : stage === 'listening'
                  ? 'Automatic turn-taking active · Speak your answer'
                  : stage === 'speaking'
                  ? 'Speak into microphone to interrupt AI playback'
                  : 'Use headphones to avoid microphone feedback'}
              </p>
            </div>
          </div>

          {/* Messages Container */}
          <div
            className="flex-1 min-h-[240px] max-h-[360px] overflow-y-auto space-y-4 p-4 bg-slate-50/50 border border-slate-100 rounded-xl"
            aria-live="polite"
          >
            {messages.length === 0 ? (
              <p className="text-center text-xs text-slate-400 italic py-12">
                Click &ldquo;Start Interview&rdquo; to begin the scripted practice session.
              </p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col ${
                    m.role === 'interviewer' ? 'items-start' : 'items-end'
                  }`}
                >
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 px-1">
                    {m.role === 'interviewer' ? 'AI Interviewer' : 'Candidate'}
                  </span>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      m.role === 'interviewer'
                        ? 'bg-white text-slate-800 border border-slate-200 shadow-2xs'
                        : 'bg-blue-600 text-white shadow-xs'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Transcript & Typed Fallback Input */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="answer" className="text-xs font-semibold text-slate-700">
                Live Speech Transcript / Manual Typed Fallback
              </label>
              <span className="text-[11px] text-slate-400">
                {inputMode === 'voice'
                  ? 'VAD auto-submits upon speech pause'
                  : 'Type answer and click Send Answer'}
              </span>
            </div>
            <textarea
              id="answer"
              rows={3}
              value={draft}
              onChange={handleDraftChange}
              disabled={!isRunning || stage === 'speaking' || stage === 'generating'}
              placeholder={
                inputMode === 'voice'
                  ? 'Spoken words will appear here in real time. You can also type your response manually.'
                  : 'Type your answer here and click Send Answer below.'
              }
              className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-50 disabled:text-slate-400 resize-none"
            />
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-slate-500">
                Candidate can correct recognized speech or type an answer directly.
              </span>
              <button
                type="button"
                onClick={handleManualSend}
                disabled={
                  !isRunning || !draft.trim() || stage === 'speaking' || stage === 'generating'
                }
                className="bg-slate-900 text-white font-medium text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
              >
                Send Answer →
              </button>
            </div>
          </div>

          {/* Status Message */}
          <div
            role="status"
            className="p-3 bg-slate-100/70 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium"
          >
            {status}
          </div>
        </section>

        {/* Right Column: Diagnostics & Checklist */}
        <aside className="space-y-6">
          {/* Live Metrics */}
          <section
            aria-label="Live Diagnostics"
            className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4"
          >
            <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              Pipeline Diagnostics
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                <span className="block text-[11px] font-semibold text-slate-500 uppercase">
                  Interruptions
                </span>
                <strong className="text-xl font-bold text-slate-900">
                  {interruptedCount}
                </strong>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                <span className="block text-[11px] font-semibold text-slate-500 uppercase">
                  Answer → Audio
                </span>
                <strong className="text-xl font-bold text-slate-900">
                  {latencyMs === null ? '—' : `${latencyMs}ms`}
                </strong>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                <span className="block text-[11px] font-semibold text-slate-500 uppercase">
                  Kokoro Device
                </span>
                <strong className="text-sm font-bold text-slate-800">
                  {modelDevice}
                </strong>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                <span className="block text-[11px] font-semibold text-slate-500 uppercase">
                  Microphone / VAD
                </span>
                <strong
                  className={`text-sm font-bold ${
                    vadSpeech
                      ? 'text-emerald-600'
                      : microphoneActive
                      ? 'text-blue-600'
                      : 'text-slate-400'
                  }`}
                >
                  {vadSpeech
                    ? 'Voice Detected'
                    : microphoneActive
                    ? 'Listening'
                    : 'Inactive'}
                </strong>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 italic">
              Latency captures turn finalization and local Kokoro synthesis before audio playback.
            </p>
          </section>

          {/* Experiment Checklist */}
          <section
            aria-label="Experiment Checklist"
            className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-3"
          >
            <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              Laboratory Checklist
            </h2>
            <ul className="text-xs text-slate-600 space-y-2 list-disc list-inside">
              <li>Listen to the AI interviewer&apos;s initial Java question.</li>
              <li>Speak into your microphone mid-playback to trigger a barge-in interruption.</li>
              <li>Complete your response and pause for ~1 second to verify auto-submission.</li>
              <li>Inspect transcription accuracy or practice using typed answers.</li>
              <li>Verify that clicking &ldquo;Stop&rdquo; immediately releases all audio resources.</li>
            </ul>
          </section>

          {/* Event Timeline */}
          <section
            aria-label="Event Timeline"
            className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-3"
          >
            <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
              Event Timeline
            </h2>
            {eventLog.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No events recorded yet.</p>
            ) : (
              <ul className="space-y-1.5 max-h-48 overflow-y-auto text-[11px] font-mono text-slate-600">
                {eventLog.map((ev, i) => (
                  <li key={`${i}-${ev}`} className="truncate">
                    {ev}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {/* Security & Privacy Disclosure */}
      <footer className="p-4 bg-slate-100/60 border border-slate-200 rounded-xl text-xs text-slate-500 space-y-1">
        <p className="font-semibold text-slate-700">Security &amp; Privacy Notice:</p>
        <p>
          <strong>Scripted demonstration, not real AI.</strong> Follow-up questions are rule-based examples. No LLM or Groq connection is used.
        </p>
        <p>
          Kokoro TTS and Silero VAD execute locally in your browser (via WebGPU/WASM). On initial load, model weights and WASM runtimes are downloaded externally from Hugging Face and jsDelivr.
        </p>
        <p>
          Browser speech recognition (`SpeechRecognition`) is provided by your browser vendor and may transmit audio to vendor servers.
        </p>
        <p>
          Transcripts and audio are strictly ephemeral in JavaScript memory. No recordings, transcripts, or audio data are sent to Roundset&apos;s backend, saved to disk, MongoDB, localStorage, or IndexedDB. Camera and fullscreen permissions are never requested.
        </p>
      </footer>
    </div>
  );
}
