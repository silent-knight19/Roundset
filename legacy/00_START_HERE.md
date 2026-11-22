# AI Interviewer — Continuity Handoff (START HERE)

**Snapshot:** 2026-11-22  |  **Status:** Product scope defined; Phase 0 feasibility validation active; full application implementation NOT started.

## Why this folder exists
Preserve every important product decision, engineering constraint, prototype outcome and open question across ChatGPT context limits. **When opening a new chat, attach this folder/ZIP or the main specifications**; don't assume chat memory alone will contain every technical rule.

## Files and reading order
1. `00_START_HERE.md` (this file): current state and immediate continuation instructions.
2. `01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`: product requirements, free/paid/VIP plans, precise anti-cheat policies, reports and UI behavior.
3. `02_ENGINEERING_ARCHITECTURE_AND_CONSTRAINTS.md`: technical decisions, privacy, backend, auth, persistence and free-cost policy.
4. `03_PHASE0_VALIDATION_AND_DECISION_LOG.md`: evidence, remaining feasibility gates, risks and the next experiment.
5. `ai-interviewer-tts-poc.zip`: P0-02 preliminary local Kokoro vs optional Aura TTS prototype.
6. `ai-interviewer-conversation-poc.zip`: P0-02B validated scripted voice conversation prototype, with optional (not yet tested) Groq mode.
7. `voice-prototype-validation-screenshot.png`: screenshot of user-tested conversation prototype.

## Hard requirements — do not renegotiate without user request
- Flagship **MERN** AI interviewer aimed at showcasing serious full-stack/SDE-1 engineering and a polished private recruiter demo.
- **₹0 required for all services** (AI, hosting, database, email, TTS, etc.). **The ONLY potential paid exception is phone/SMS OTP credits.** No unannounced paid cloud resources or API tiers.
- **Firebase Authentication Google Sign-In/OAuth must remain**, alongside **custom Express + MongoDB email/password**, email verification/OTP, password reset, account linking and robust backend sessions. Phone OTP architecture included; real SMS may await paid credits.
- Human-like **voice-first conversation with natural automatic interruptions**. Primary chosen pipeline: **browser SpeechRecognition + Silero VAD + local Kokoro TTS**. User tested scripted prototype and reported voice as excellent and natural; screenshot shows **2 barge-ins, ~1052 ms answer→AI-audio, WebGPU**. **This does NOT yet validate live LLM latency**.
- Free plan: **one 15-minute interview per calendar month**, consumed even if valid anti-cheat termination. Free result displays **overall score /10 only**; clicking details triggers paywall.
- Paid plan prices/quotas: **₹250/10**, **₹500/25**, **₹1,000/50 interviews/month**. Same premium feature set at every price; only count differs. Premium includes detailed question-level feedback and improved answers, resume/JD-based sessions, PDF/transcript and advanced analytics/coaching.
- Free/private/demo invite system and an **admin console**: full operational oversight, quota overrides, account management, VIP no-app-level-count-cap access, invitation emails, subscriptions, audit logs. No administrator access to passwords, OTPs, session tokens or card secrets.
- Both interview modes require microphone/camera and fullscreen; rigorous but reasoned anti-cheat policy. **Mandatory 15-minute cooldown after integrity termination** (not the same as a free interview's 15-minute duration).
- **Payment gateway NOT chosen.** Sandbox subscriptions first; no real revenue/charges enabled. Avoid presenting live commercial feasibility as demonstrated.
- User delegates routine engineering design to ChatGPT; minimize decision questionnaires. **Responses in chat must be short, structured and one difficulty at a time.** Documentation may be detailed.

## Immediate next action: DIFFICULTY 2 — AI inference limits
The user explicitly wants to move to **Difficulty 2** now that these resources are saved.

**Goal:** Establish whether Groq free inference can support a live, realistic voice interviewer, including variable follow-ups and scoring, at ₹0. Continue with **P0-01/live Groq integration and capacity measurement** (not another TTS comparison). Use the existing `ai-interviewer-conversation-poc.zip` and its optional Groq backend rather than rebuild the audio pipeline.

**Run sequence:**
1. User adds `GROQ_API_KEY` locally in `server/.env` (never share it or commit it).
2. Start API and frontend per prototype README; choose Groq mode; consent for sending synthetic transcripts. No real private resumes, PII or confidential code until provider privacy settings are verified.
3. Test 5–10 varied questions/answers with follow-ups; log TTFT or inference latency, TTS generation latency separately, token input/output per turn, rate-limit errors, transcription quality, and interruptions during real model replies.
4. Run small reproducible 15-minute simulation and estimate **input/output token budget per 15/30/60-minute session**, plus maximum sessions/concurrency at actual account quotas. Clearly distinguish measured vs projected.
5. Implement **hard admission limits**, per-account and global quotas, fail-closed spending limits, throttling/fallbacks; prioritize a model/provider strategy that stays ₹0. Never automatically switch to paid inference.
6. Decide next engineering design only after test evidence. Other difficulty threads: long 30–60 min sessions; Render cold starts/resource limits; anti-cheat accuracy; privacy.

## State of work
- **P0-02A local TTS**: Kokoro voice quality user-approved; Cloudflare Aura was **not tested**.
- **P0-02B scripted natural-conversation POC**: user-approved; 2 interruptions shown and ~1.052 s answer→AI audio in screenshot. Mode was explicitly **Scripted demo — no API key**.
- **P0-01 real Groq inference**: pending (optional integration exists in POC; no reported live user results).
- **Core backend/database/payments/auth/admin/reporting/anti-cheat production implementation**: not started.

## Resume/research integrity
Never claim: real paid subscriptions; measured Groq capacity; Gemini or Aura comparative superiority; fully validated privacy; microphone interruption reliability under all devices; production-grade anti-cheat; end-to-end successful long interviews. Report only what was actually tested.

## Handoff prompt for a future ChatGPT session
> I am continuing the AI Interviewer project. First read `00_START_HERE.md`, `01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`, `02_ENGINEERING_ARCHITECTURE_AND_CONSTRAINTS.md`, and `03_PHASE0_VALIDATION_AND_DECISION_LOG.md`. Treat them as the project decision baseline. The main user instruction is concise answers, one engineering difficulty at a time, and zero spending except optional SMS OTP credits. P0-02B scripted voice prototype was user-validated; we are now resolving **Difficulty 2: Groq free AI inference quotas and concurrency**. Do not redesign already chosen features, do not ask repetitive low-level questions, and distinguish approved decisions from proposals and tests pending.
