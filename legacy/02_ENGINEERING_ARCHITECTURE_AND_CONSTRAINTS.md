# AI Interviewer — Architecture, Security, Privacy and Cost Constraints

**Version:** 1.0 (2026-11-22) · Architecture is **proposed** unless labeled **fixed/decided**; *not an implementation-ready final design*.

## 1. System architecture principles

**Decided architectural direction:** modular monolith (Node.js/Express API) + React/TypeScript frontend + MongoDB, not a constellation of paid microservices. Prioritize transactional correctness, secure boundaries, understandable code and testability.

```
React + Vite + TypeScript (Cloudflare Pages Free — proposed)
  ├─ Authentication: Firebase Google OAuth (decided)
  ├─ Interview UI: config, voice, transcript, Monaco, reports
  ├─ Browser Media: SpeechRecognition, Silero VAD, Kokoro TTS, MediaPipe
  ├─ Dashboard: analytics, history, billing/upgrade
  └─ Admin console: RBAC restricted
                    |
             HTTPS / secure session
                    v
Node.js + Express API (Render Free — proposed)
  ├─ Auth and identity federation (Google token verification + custom email auth)
  ├─ Interview state machine, timeouts, recovery and context
  ├─ AI provider adapter, prompt/rubric schemas, rate limiting
  ├─ Report/evaluation pipeline and entitlement gates
  ├─ Quotas/subscription ledger/payment sandbox/webhooks
  ├─ Invitations/VIP/admin authorization/auditing
  └─ Monitoring, abuse limits, health checks
                    |
      MongoDB Atlas M0 (Free — proposed)
      ├─ users / authIdentities / sessions / verificationChallenges
      ├─ interviews / interviewEvents / questions / responses
      ├─ evaluations / reports / skillProgress / codeSnapshots
      ├─ plans / subscriptions / quotaLedger / paymentEvents
      ├─ invitations / integrityIncidents / adminAuditLogs
      └─ systemSettings / providerUsage
```

**State authority:** browser reports observations and sends data; backend alone enforces interview status, deadlines, score publication, quota changes, premium entitlements, cooldowns, invitations and admin permissions. LLM output cannot execute administrative operations.

## 2. User-facing frontend stack
- **Fixed:** React + TypeScript, MERN model. **Proposed:** Vite, Tailwind CSS, shadcn/ui, React Router, Zustand, TanStack Query, Monaco editor, Recharts and jsPDF.
- Voice pipeline is **device local where possible**: browser SpeechRecognition (may be remotely processed by browser vendor), Silero VAD via ONNX runtime, `kokoro-js` with WebGPU primary/WASM fallback. Kokoro synthesizes local speech after initial model download. Backend does not need to receive raw audio for routine TTS.
- Use microphone permissions and output/echo cancellation; headphones encouraged during prototype. VAD detects *activity*, not speaker identity. Browser STT may miss initial barge-in words when restarted; do not claim this is solved.
- Use MediaPipe face-count/presence/head-pose *locally* for anti-cheat. Accuracy, false positive mitigation and policy need empirical evaluation; browser frontend cannot prevent all cheating or tampering.
- PWA/offline support not mandatory; no need for paid infrastructure.

## 3. Primary natural voice pipeline — approved from user experiment

```
Mic stream -> Silero VAD ────────┬─> speech-start during playback -> stop current Kokoro audio
                               └─> turn end -> finalize transcript
SpeechRecognition (Web Speech API) -> editable words -> Express interview controller
             -> Groq text model (pending live validation)
             -> controlled AI response text -> Kokoro local speech -> browser playback
```

**Tested in scripted demo:** user confirmed highly natural voice and automatic interaction; 2 interruptions shown, displayed 1052 ms answer-to-AI-audio timing, WebGPU. Not a Groq live latency benchmark, not full-duplex native speech-to-speech.

**Voice technical issues to validate:** recognition restart can miss opening words, background speaker/AI echo can produce false barge-ins, natural end-of-turn cannot just cut off after one pause, browser compatibility/privacy/permission problems, first model download and memory on mobile, true warm model latency and sustained 60-minute performance. Fallback: manual transcript correction and browser speechSynthesis; Whisper may be evaluated as fallback but was not user-approved as mandatory primary.

**Not using as default:** Gemini Live. It offers real-time audio and interruptions, but unpaid API privacy/session limits were identified. If used at all in prototyping, use synthetic/non-sensitive content and verify latest terms. Cloudflare Aura-1 was considered but not successfully tested; not required to progress.

## 4. AI model engineering and quotas

- **Planned text inference:** Groq, with GPT-OSS 120B as initial benchmark candidate (not an irrevocable final choice). Adapter abstraction for substituting free models/providers with their own terms/quotas. Live Groq testing is **pending**.
- Keep API keys **server-side** in environment/secrets, never frontend bundles, screenshots, chat or Git.
- Different structured AI calls: question planner, interviewer/turn follow-ups, evaluator, report generation; minimize needless model calls (e.g., do not rescore unchanged answers on every turn). Validate model output strictly.
- Require per-provider request/token quotas, per-user/month entitlements, global concurrency cap, hard disable at free quota exhaustion, bounded retries, circuit breaker and graceful degradation. Never silently route to paid model, and do not assume an app VIP user has unlimited provider resources.
- Determine token/minute and requests/minute from actual account's dashboard, not old published values. Prior research mentioned Groq free model **~1000 requests/day, 200k tokens/day, 8k tokens/min**; values are **time-sensitive and not independently verified by this document**.
- Correct latency instrumentation: capture answer end -> backend request start, LLM TTFT/final text, TTS synthesis start/end, first playback event and acoustic first syllable where observable. Screenshot 1052 ms is a **scripted-demo** UI metric, not general production latency.
- Privacy: send user transcript to Groq only with informed consent and after reviewing current retention settings. Use Zero Data Retention where available/configured. Do not submit personal/confidential content to services whose free tier terms prohibit that use. Have deletion/retention policies for stored transcripts/resumes.

## 5. Auth design (must preserve both Firebase and custom backend)

**FIXED:** Firebase Authentication **Google Sign-In/OAuth stays**. Also develop custom backend **email/password registration and login**, verify-email OTP, resend, forgot/reset/change password, secure refresh/access sessions, multi-device sessions/revocation, logout/logout all. Optional TOTP 2FA and link/unlink identities. Phone/SMS OTP provider abstraction required; real SMS paid credits only permitted exception. No Firebase removal and no replacement with a purely custom OAuth stack.

Suggested flows:
- **Google path:** Google login via Firebase SDK -> Firebase ID token -> backend verifies token using Firebase Admin -> lookup/link or provision application user -> backend issues its own app session. Do not merge accounts based solely on matching unverified email strings.
- **Email path:** Express handles email registration/password check, Argon2id hash storage, email verification OTP, reset; same app session abstraction as Google accounts.
- **Phone path:** reusable one-time verification challenge and provider interface; production SMS dependent on provider terms/small credit; implement mock/test provider with obvious environment distinction.
- **Sessions:** short-lived access credentials and rotating revocable refresh token in HttpOnly Secure cookies where appropriate; CSRF defense, strict CORS/origin, XSS mitigation, rate limits and credential stuffing defenses; secure token storage/rotation/jti hashed records. Confirm actual cookie/origin deployment scheme before freeze.
- **OTP:** never log OTP text; hashed/HMAC verifiers, short TTL (e.g. 5 min proposed), max attempts (e.g. 5), resend throttling, single-use and per-IP/account throttling.
- **Authorization:** candidate, admin (super admin), optional support/mentor capabilities. No trust in client plan/role field. Always check resource ownership.

**Email service proposed:** Brevo HTTPS email API free allowance (previous research: 300/day, terms may change). Sender/domain verification and delivery must be tested; SMTP may not work on free hosting.

## 6. Payments, premium access and quota correctness

**Not decided:** concrete payment gateway. Razorpay/Cashfree/Stripe had been considered as options; do not lock anything until user chooses. Use provider-neutral billing domain and test-mode adapters first. No real money collected by the portfolio deployment. All proposed plan amounts/quota counts are in the product requirements file.

- Authorization: `hasEntitlement(user, feature)` checks server-side plan/VIP status and expiry; premium report API must withhold premium data from Free. Do not rely on blurred UI alone.
- Interview quota: append-only-ish ledger entries (`RESERVE`, `COMMIT`, `RELEASE`, `ADJUST`, `RENEW`) with idempotency keys and atomic user-period concurrency control. Store actual session-credit mapping. Reconciliation detects discrepancies. Monthly Free calendar reset vs paid billing anniversary; no accidental double grant after renewal/retry.
- VIP: separate entitlement from billing; `unlimited_interview_count=true` in app, constrained by global AI capacity; revoke and expire without touching original payment status.
- Billing event handler: verify provider signature over raw request body, unique event key, duplicate/out-of-order safety, authoritative subscription lookup and replay-safe transitions. Use test-only receipts, upgrade/downgrade/cancel/renew/refund simulations.
- Enforce anti-cheat cooldown and global AI admission even for VIP and paid accounts. Quota-exhausted user sees upgrade/wait reason without bypass.
- **No paid AI, no paid hosting, no pay-as-you-go cloud charging**. Exception only SMS OTP. User specified price plans to demonstrate product/engineering, **not to authorize any real payments**.

## 7. Interview state-machine proposal

Suggested states (`DRAFT`, `PREFLIGHT`, `READY`, `ACTIVE`, `RECOVERING`, `COMPLETED`, `TERMINATED_INTEGRITY`, `ABORTED_SYSTEM`, `EXPIRED`) and valid transitions; formal transition table pending full blueprint.
- Server issues session identifiers and deadline. Start countdown only when interview actually starts, not during backend cold start.
- Candidate inputs are associated with immutable turn/question IDs; new follow-ups sequenced and recorded.
- Checkpoint on each stable unit of work, store periodic code snapshot/diff, transcript revisions, evaluation and integrity event sequence.
- On reconnect validate auth, ownership, device requirements, deadline and cooldown; restore context and previous warnings without double counting.
- Use retry- and race-safe sequence/version checks and idempotency for model calls, answer submission and evaluation results.
- Distinguish deliberate abuse from network failure. Record reason and prevent unjust consumption of credit when service failures verified.

## 8. Data storage, privacy and admin

Collections **proposed**, not finalized schema: `users`, `authIdentities`, `sessions`, `verificationChallenges`, `interviews`, `interviewEvents`, `questions`, `responses`, `evaluations`, `reports`, `skillProgress`, `codeSnapshots`, `plans`, `subscriptions`, `quotaLedger`, `paymentEvents`, `invitations`, `integrityIncidents`, `providerUsage`, `adminAuditLogs`, `systemSettings`.

Sensitive data principles:
- No plaintext passwords, OTPs or raw refresh tokens in database.
- No raw microphone/camera footage persistent storage by default. If audio/video storage ever considered, explicit separate consent, retention controls and abuse review required.
- Interview audio/transcript user disclosure, processing purposes, access/export/delete.
- Data deletion must account for session records, resume, transcript, code and derived scores; legally/accounting-required payment-event retention may be separate.
- Admin may access operational user information and perform account operations, but privileged access to private transcripts/resumes must be narrowly scoped, logged and justified. Avoid a global admin “see everything secretly” capability.
- Server access controls and audit logging for all admin changes. No sensitive fields in error logs.

## 9. Deployment candidates (NOT validated)

| Concern | Candidate | Constraint |
|---|---|---|
| Frontend | Cloudflare Pages Free | confirm deployment limits and custom domain needs |
| Node API | Render Free Web Service | 15-min idle sleep/cold wake; ephemeral filesystem, shared free CPU/RAM |
| Database | MongoDB Atlas M0 Free | ~512 MB storage and throughput limits; confirm current offer |
| Email | Brevo free API | quota, sender verification, possible free-plan limitations |
| Google OAuth | Firebase Authentication | confirm current free-tier terms, authorized domain and Admin integration |
| SMS | Provider-neutral OTP gateway | **only** possible paid exception |
| Text LLM | Groq free account | user-specific quotas and data terms |
| TTS | local Kokoro | WebGPU browser support, memory/download and device performance |
| STT | Web Speech API | may rely on remote vendor; availability and privacy vary |
| VAD/proctoring | Silero + MediaPipe local | client CPU/battery, false positives and no identity assurance |

**Render cold wake mitigation:** expose preflight readiness step before session start, persist all durable state in MongoDB (never on ephemeral filesystem), keep AI/network timeouts reasonable. Do not use keep-alive hacks violating free-hosting terms.

## 10. Quality engineering and nonfunctional targets

**Pending numeric targets** (not measured): realistic STT/TTS + AI response latency, 15/30/60 min end-to-end failure rate, total token/credit consumption, concurrency, false-positive incidence, model scoring agreement, security and cost invariants.

Required test suites:
- Authentication/OAuth/OTP/session rotation/rate limits/CSRF/permissions.
- Quota ledger simultaneous starts, duplicate webhook delivery, renewal/billing race conditions, admin overrides.
- Interview event replay, refresh/reconnect, timer/cooldown persistence, idempotent question evaluation, provider outage.
- Anti-cheat thresholds and camera disconnection/multi-face false-positive handling.
- PDF generation, privacy export/deletion, paywall API withholding, report eligibility.
- Static/synthetic answer evaluation rubric benchmark, observed latency and token usage.

## 11. Sources and maintenance (informational, not live verification in this snapshot)

- Kokoro JS: https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md
- Silero browser VAD: https://docs.vad.ricky0123.com/user-guide/browser/
- Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Groq rates: https://console.groq.com/docs/rate-limits
- Groq data settings: https://console.groq.com/docs/your-data
- Gemini Live: https://ai.google.dev/gemini-api/docs/live
- MongoDB Atlas Free: https://www.mongodb.com/pricing
- Render Free: https://render.com/docs/free
- Cloudflare Pages limits: https://developers.cloudflare.com/pages/platform/limits/
- Firebase Authentication: https://firebase.google.com/docs/auth
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

Provider terms, prices and rate limits **must be revalidated before dependency lock-in**; this document only records prior architecture direction and issues to test.
