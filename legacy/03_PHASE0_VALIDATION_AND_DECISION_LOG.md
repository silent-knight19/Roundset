# AI Interviewer — Phase 0 Validation, Decisions, Risks, and Next Engineering Action

**As of:** Sunday, 2026-11-22 (Asia/Kolkata). This is a historical handoff, not a live external-provider verification. **Do not mark a test passed solely because documentation supports the approach.**

## 1. Phase 0 scope

**Goal:** prove the private demo can run at ₹0, with reliable natural voice conversation and a backend that does not waste free AI quotas. Prototype first, freeze implementation architecture after testing.

| ID | Area | Actual status | Next action |
|---|---|---|---|
| P0-02A | Local TTS comparison | **User tested and liked Kokoro; Aura not tested** | Keep Kokoro primary; optional Aura not blocking |
| P0-02B | Natural conversation, STT/VAD/TTS | **User tested scripted demo; reported excellent naturalness and working conversation** | Integrate real AI and test barge-in under AI latency |
| P0-01 | Real LLM questions/follow-ups/scoring | **NOT TESTED with real Groq yet** | **NEXT** — measure real inference quality, latency, tokens, limits |
| P0-03 | 15/30/60-minute stable interviews | **NOT TESTED** | Long soak; renew/recover sessions; evaluate CPU/memory |
| P0-04 | MediaPipe face/voice anti-cheat | **NOT TESTED** | Measure detection quality, edge cases, privacy and false positives |
| P0-05 | Render + Atlas + Firebase + email | **NOT TESTED end-to-end** | Deploy preflight, auth/OTP, database and resilience experiment |
| P0-06 | Billing sandbox, VIP, admin | **NOT TESTED** | Implement later after core voice/AI validation |

## 2. Actual evidence: two prototype archives

### `ai-interviewer-tts-poc.zip`
- Local React/Vite + Node proof of concept, four interview texts comparing **Kokoro 82M (`kokoro-js`)** and optionally **Cloudflare Aura-1** (Cloudflare credentials required). Voice interruption in this POC is **manual**, not microphone-based.
- User stated: “I tested Kokoro 52 million variant. It was so good but I was unable to test the Cloudfares one”. **Important discrepancy:** user called it **52 million**, whereas the archived prototype README/source call it **Kokoro 82M**. Do **not** silently rewrite that discrepancy as conclusive evidence of which exact parameter count was tested. Confirm variant from installed source/model settings if relevant later.
- Cloudflare Aura was **not tested**, so no meaningful comparison/latency ranking exists.
- Do not make Aura a blocker. Kokoro voice quality user-approved.

### `ai-interviewer-conversation-poc.zip`
- React + TypeScript/Vite; **Kokoro 82M**, **Silero VAD v6**, **browser Web Speech API**, rule-based scripted interviewer, optional Groq Node API backend.
- Archived README says start via `npm install`, `npm run api`, `npm run dev`; open `http://127.0.0.1:5173` in Chrome. No API key needed in **Scripted demo**; optional `server/.env` holds `GROQ_API_KEY` for real AI mode.
- **Screenshot** captured the UI in **Scripted demo — no API key** with Kokoro voice `af_heart`, interruption count **2**, **Answer → AI audio 1052 ms**, TTS device **webgpu**, and successful user/AI text exchanges.
- User explicitly said: “It is working excellent, it is too good and too natural.”
- Metric caveat: UI says latency includes scripted AI reply and complete Kokoro synthesis, **not streaming first-audio latency**. Do not attribute this figure to real Groq AI.
- Prior assistant reported **7 backend tests passed**. This reflects local tests of proxy/logic (not live inference), and does not prove browser reliability beyond user manual test. React production build not asserted passed in prior answer.
- Important issues listed in archive README:
  - Scripted mode is *not* true full-duplex LLM; voice pipeline is STT→text→TTS with interruption of playback.
  - Browser SpeechRecognition restart may lose first words during speech barge-in. Editable transcript offered.
  - AI audio leaking into mic may falsely trigger VAD; use headphones; true speaker recognition/echo handling pending.
  - End-of-turn ~950 ms silence plus ~650 ms browser finalization in prototype; short answer pauses may cut off speaker.
  - Browser STT may be cloud-backed; mic privacy not automatically local.
  - First-party model weights and VAD/ONNX files require internet on initial load.
  - Prototype content is held in app memory, no persisted production records; no sensitive interviews allowed in demo.
  - Optional Groq API route has a protective **25 requests/server-start**, one request at a time, **no automatic retries**; not a production global quota guarantee.

## 3. Decisions ledger (ordered)

| ID | Decision | State |
|---|---|---|
| ADR-001 | MERN full-stack flagship AI interviewer with detailed technical and behavioral practices | Approved |
| ADR-002 | Auto-configuration, resumes/JD, coding, rubrics, history, PDF, adaptive interview planning | Approved product scope |
| ADR-003 | Mandatory camera/mic/fullscreen and detailed warning/escalation/cooldown rules | Approved product policy; accuracy untested |
| ADR-004 | Firebase Google OAuth **plus custom email/password + OTP**; phone SMS optional paid exception | Approved; not implemented |
| ADR-005 | Strict ₹0 for all other service categories | Mandatory |
| ADR-006 | Free **1×15 minutes/month**, overall score only; terminated misconduct consumes quota | Approved; supersedes older Free 2×15 drafts |
| ADR-007 | ₹250 / 10, ₹500 / 25, ₹1000 / 50 interviews/month, shared premium features | Approved sandbox plans |
| ADR-008 | VIP email invitations and privileged admin dashboard; global limits still apply | Approved product scope |
| ADR-009 | Payment method open; sandbox only, no real charges | Approved boundary |
| ADR-010 | Session event/checkpoint recovery, idempotency, backend-controlled deadlines | Approved engineering direction |
| ADR-011 | Natural speech with interruption a hard requirement | Approved |
| ADR-012 | Browser STT + Silero VAD + Kokoro local voice as **primary** | Approved after user prototype validation |
| ADR-013 | No need to block on testing Cloudflare Aura | Approved |
| ADR-014 | Groq text inference for first live experiment; free quota/cost safety | **Proposed model; experiment pending** |
| ADR-015 | Render Free / Atlas Free / Cloudflare Pages free hosting | Provisional; deploy/test pending |
| ADR-016 | Full admin visibility constrained by privacy, audit and least-privilege rules | Approved guardrail |

## 4. Unresolved difficulties the user selected

1. **Natural real-time voice/privacy/free quotas** — partially resolved: scripted conversation prototype user-validated with Kokoro + VAD + browser STT. Need real Groq test; voice privacy and speech recognition cloud behavior remain caveats.
2. **AI inference free limits** — **NEXT PRIORITY**: requests/minute, tokens/minute, tokens/day, concurrency, possible rate limits and monthly capacity.
3. **Long 30–60-minute interviews** — backend timekeeping, conversation checkpoint restoration, session renewals and browser memory endurance not validated.
4. **Render hosting cold start/resource limits** — frontend preflight + API wake-up + zero transient loss not validated.

Other deferred validation: anti-cheat false positives and audio speaker confusion; privacy/consent and data-retention behavior; email OTP and Firebase/custom auth coexistence; invitation issuance; sandbox payment webhooks.

## 5. NEXT: P0-01 — live Groq inference benchmark protocol

Use existing P0-02B archive rather than rewriting the working audio flow. Keep the prototype in its scripted/optional-Groq modes so it remains runnable with no key.

### Setup
- `cp server/.env.example server/.env`; insert user's own `GROQ_API_KEY` locally (not sent to ChatGPT, not committed); `npm install`; `npm run api`; `npm run dev`.
- Prohibit unbounded retries. Preserve the existing per-start development request cap unless consciously changed with explicit measured reason.
- Only synthetic interview examples initially; explicit consent to send text to Groq; no identifiable resume, real private code or sensitive data.
- Inspect Groq console actual quota values and provider terms for the user's account. Distinguish published values from user account-specific rates.

### Benchmarks
1. Five or more distinct Java/backend/DSA interview questions, including easy and difficult questions.
2. For each, sample concise fully correct, partially correct, incorrect and ambiguous answers; evaluate question follow-up relevance and scoring accuracy.
3. Record end-of-candidate-answer → server-request latency; LLM API latency (time-to-first-token if streaming / full response), TTS synthesis, first browser playback, and end-to-end felt latency (separate metrics).
4. Log prompt/input/output tokens, requests, throttling and error type/status, and failures/timeouts. No guess-based claims.
5. Run a simulated **15-minute workload**, then estimate 30/60 min and 10/25/50 quota plans **with assumptions documented**. Check provider hard limits and global concurrency. Reconcile paid plan promises vs zero-cost reality.
6. Probe automatic interruptions while a real LLM reply is arriving and TTS is playing. Ensure stale generation doesn't play after candidate interrupts.
7. Verify free quota exhaustion degrades gracefully and **never bills** user or account.

### Suggested acceptance gates (targets, not pass results)
- Stable non-duplicating multi-turn dialogue and valid question/evaluation schemas.
- Human-reviewed follow-up relevance ≥90% on adequate benchmark examples; no unsupported score deductions in reviewed cases.
- End-to-end AI latency acceptable for live interview (set threshold from observed distribution, ideally p50/p95 after warm runs).
- Requests and tokens per full session measured; capacity known before setting promise of paying users.
- No keys in client, no transcript sent before consent, no automatic spend, no indefinite retry loops.

**Decision required after experiment:** continue with Groq as primary, optimize prompts to fit quotas, add alternate zero-cost provider or model, or reduce expected concurrent/demo usage. Do not decide based on scripted audio metrics.

## 6. Risk register

| Risk | Impact | Mitigation / Owner |
|---|---|---|
| Groq quotas / account capacity | Paid plan claims can't be served | Hard global admission, measurements, sandbox-only payments; architect + dev |
| Browser STT may transmit audio | Candidate privacy conflict | Clear consent, browser support checks, local fallback investigation; privacy audit |
| Restart loses beginning of interruption | Misheard candidate | Buffered audio fallback exploration, transcript correction, tests |
| AI echo triggers Silero | Invalid barge-in / anti-cheat | Headphones during tests, echo cancel, suppression, separation tests |
| 30–60 min client session fails | Lost work | Server state machine, periodic persisted events, soak tests |
| Render sleeps when idle | First interview latency | Backend preflight before timer; datastore persistence |
| Free database small | Session/transcript overflow | Retention, size limits, archived reports, monitor usage |
| Anti-cheat false positives | Unfair user termination | Local quality metrics, event grouping, appeal/override, contextual rules |
| OAuth + custom account linking | Unauthorized account takeover | Verify claims, ownership proof, session hardening |
| Admin 'view everything' idea | Privacy abuse risk | Least privilege, audited support access and no raw secrets |
| Subscription double spend/race | Lost or duplicated credits | Idempotent ledger, atomic quota enforcement, tests |
| Provider pricing changes | ₹0 constraint broken | Review official pricing regularly, no auto-upgrade to paid |

## 7. Next sequential engineering phases (not started)

0. Feasibility: P0-01 and remaining P0-03/04/05.
1. Repository foundation, auth, secure identities and roles.
2. Interview backend controller, configuration, state/events, recovery.
3. Production voice integration, coding UI, anti-cheat monitoring.
4. Evaluation, reports, analytics and privacy flows.
5. Sandbox plans/paywall, subscription state, quota ledger and entitlement checks.
6. Admin console, invitations/VIP, audit logs and system control.
7. Security and load tests, benchmarks, documentation and deployment.

## 8. Important distinction: what is really done

**Done:** Many product decisions; planned architecture; two packaged prototypes; real user validation that **Kokoro scripted conversation feels excellent**; screenshot evidence showing 2 interruptions and 1052 ms UI metric.

**Not done:** live Groq benchmarking, end-to-end backend auth, working payments/admin/VIP, long-session reliability, proctoring accuracy, actual deployment or verified commercial capacity. **Do not claim those are delivered.**
