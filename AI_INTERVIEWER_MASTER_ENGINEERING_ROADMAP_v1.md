# AI Interviewer — Master Engineering Roadmap

**Version:** 1.0  
**Date:** 2026-11-22 (Asia/Kolkata)  
**Purpose:** Authoritative implementation roadmap for the MERN AI Interviewer project. This is an actionable plan, NOT a claim that production features have been built.  
**Read with:** `docs/ENGINEERING_RESEARCH_AND_ADRS.md`, `docs/API_AND_DATA_CONTRACTS.md`, `docs/PHASE_01_CODING_BRIEF.md`, and the canonical requirements in `legacy/01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`.  
**Next action:** Execute Phase 1 in `docs/PHASE_01_CODING_BRIEF.md`. **No more open-ended feature brainstorming.**

## 1. What we are building

A **voice-first AI interviewer and interview-preparation SaaS demo** for technical, coding and behavioral interviews. Candidates set a role, topics, difficulty and interview length; a conversational AI asks questions and contextual follow-ups. The system enforces interview rules, saves progress, privately evaluates answers, and presents results according to subscription entitlements. Paid plans unlock question-level AI feedback, improved answers, detailed PDFs, resume/JD-specific interviews, GitHub project deep dives, analytics, coaching and multi-round simulations. A secure administrator console manages account access, invitations, quotas, subscriptions, platform settings, integrity events and usage.

**Target:** A serious SDE-1 resume project showing domain modeling, real-time media coordination, backend state machines, idempotent quota accounting, secure identity federation, AI gateway integration, reliable session recovery, sandbox billing, RBAC and testing. **Deployment type:** private/recruiter demo first; not an actually revenue-generating or scalable commercial service.

### 1.1 Non-negotiable product decisions

| Domain | Frozen requirement |
|---|---|
| Cost | **₹0 for all project services**, except optional phone/SMS OTP credits. No paid LLM, hosting, database, monitoring or TTS. |
| Authentication | **Keep Firebase Authentication for Google Sign-In** AND build custom Express/MongoDB email/password login, email verification/reset OTP and secure app sessions. Support a phone OTP adapter (real SMS only if the sole budget exception is accepted). |
| Conversation | Human-like **voice-first** interaction, automatic end-of-turn detection, spoken interruptions and responsive follow-ups. |
| Validated voice | **Kokoro local TTS + Web Speech API STT + Silero VAD**. Scripted demo worked well; don't rebuild it without cause. |
| Models | **Groq Qwen 3.8 27B initial primary**, **Cloudflare Workers AI same-model fallback** conditional on free-plan eligibility and privacy/config checks; model quality is benchmarked, not assumed. |
| Free | **One fixed 15-minute interview per calendar month**. Free UI displays **overall score /10 only** after a valid completed interview. Clicking details opens the paywall. Integrity-terminated interview consumes the free credit. |
| Paid (sandbox) | ₹250 = **10**, ₹500 = **25**, ₹1,000 = **50** interviews per monthly billing period; **same premium features** at all paid prices; custom 10–60 minute duration. |
| VIP | Admin-granted email-bound invitation, full premium entitlement and **no app-level interview count cap**, still subject to platform capacity and anti-cheat. |
| Billing | **No real payments enabled**. Payment gateway provider undecided; build provider-neutral contracts and test mode only. |
| Integrity | Mic, camera and fullscreen mandatory for Practice AND Assessment; preserve exact yellow/red escalation and recovery/cooldown policies from canonical requirements. |
| Results | Privately score each answer 0.0–10.0 using a question rubric; full 10/10 must be attainable; never conflate anti-cheat with competence. Detailed reporting is premium. |
| Admin | Operational control with user management, quotas, VIP, plan changes, warnings, audit trails; no access to passwords/OTP/tokens/payment credentials or unlogged arbitrary private data. |
| Reliability | Backend-authoritative deadlines, event/checkpoint persistence, idempotent operations, fair system-failure refund logic. |
| User workflow | ChatGPT designs architecture/specs/reviews; coding may be performed by developer or IDE agents. Each phase ends with real test evidence, not inferred completion. |

**Precedence rule:** Newer explicit decisions in this roadmap override older drafts only where the user changed scope. For exact anti-cheat timing and premium/free boundaries, consult `legacy/01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`. Never silently loosen or replace them.

### 1.2 Features and access control

| Function | Free | Paid / VIP | Implementation owner |
|---|---|---|---|
| Register/login: Google + email/password | Yes | Yes | Auth + Identity |
| Technical/behavioral mixed Practice & Assessment | Yes | Yes | Interview Core |
| Natural voice, mic, camera, fullscreen and coding editor | Yes (within 15 min) | Yes | Voice + Proctoring + Coding |
| Manual topics/difficulty/role selection | Yes | Yes | Interview Configuration |
| Interview usage | 1 × 15 min/calendar month | 10, 25, 50 per billing month; VIP uncapped count | Entitlements/Quotas |
| Overall completed interview score /10 | Yes | Yes | Evaluation + Results |
| Question-level score, corrections, model answers, full PDF, detailed transcript UX | Locked | Yes | Evaluation + Premium Access |
| Resume/JD upload, JD-specific and repository-based interviews | Locked | Yes | Content Personalization |
| Advanced analytics, answer coach, weak-topic drills, study plan, full mock onsite | Locked | Yes | Analytics + Coaching |
| Billing history and plan management | Plan status | Billing sandbox features | Billing |
| Own personal-data access/export/deletion | Yes (not paywalled) | Yes | Privacy |
| Admin management / invitations | Admin role only | Admin role only | Admin |

**Gate check is on the backend.** Never merely blur premium data that was sent in a Free API response.

## 2. Actual current status (evidence, not assumptions)

- **Voice proof-of-concept tested:** The user validated the `ai-interviewer-conversation-poc.zip` scripted mode and reported excellent naturalness; screenshot showed **2 microphone barge-ins** and **1052 ms displayed answer-to-AI-audio time**, using Kokoro local WebGPU TTS. This number **does not include real model inference** and is not a production speed SLA.
- **Live Groq metric artifact received:** `reference-prototypes/groq-interview-metrics.csv` shows **16 successful `qwen/qwen3.8-27b` calls**, **4,281 input tokens**, **409 output tokens**, **4,690 total**, median recorded API roundtrip **651.5 ms**; largest **7,699 ms**. The file also has **two other-model rows with blank input/output counts and latency 0**; exclude them from benchmark claims. The 16 calls were short follow-up outputs, **not a complete 15/30/60 min interview or evaluation-quality study**. Network issues were reported separately; no API errors were recorded for the 16 Qwen rows.
- **Not built yet:** production auth, database, interview orchestrator, quota ledger, payments, admin console, full scoring, proctoring, long-session persistence, real Cloudflare failover.
- **Project context snapshot:** `legacy/` documents and the prototype archives are bundled to avoid chat-context loss.

**Engineering judgment:** Phase 0 gives enough confidence to start application implementation. Integrate remaining feasibility checks **as acceptance gates within milestones**, not as endless separate research cycles.

## 3. System architecture and implementation defaults

```text
Browser / React + Vite + TypeScript
  ├── Candidate portal: signup, interview planner, voice/coding session, results, dashboard
  ├── Admin portal: users, invitations, entitlements, usage, audit
  ├── Local media: Web Speech Recognition + Silero VAD + Kokoro TTS + MediaPipe
  └── HTTPS / same-origin /api proxy (deployment design described below)
                     │
                     ▼
Express modular monolith (Node.js 22+, TypeScript)
  ├── Identity / Firebase Google ID-token exchange / email auth / sessions
  ├── Authorization / plans / quota ledger / VIP invitations
  ├── Interviews / deterministic state machine / time / persistence / recovery
  ├── AI gateway / Groq primary / Cloudflare Workers AI fallback / budget controls
  ├── Questions + rubrics / evaluations / result projections / reports
  ├── Proctoring incident processor / policy rules
  ├── Resume + JD / public GitHub repo inspection / coding analysis
  ├── Billing sandbox / verified webhook adapter
  ├── Admin / audited privileged operations
  └── Structured metrics / health / capacity limits
                     │
                     ▼
MongoDB Atlas Free — source of truth, indexed schemas, no production state on local disk
```

### 3.1 Deployment architecture (deliberate engineering decision)

- **Initial local dev:** Vite proxy `/api` → Express on localhost; same-origin browser requests and secure session design.
- **Preferred no-domain live demo:** Cloudflare Pages static React frontend; a **very thin Pages Function reverse proxy** for `/api/*` forwarding to the Express API on Render Free, so browser sees **same-origin** requests and first-party HttpOnly cookies. Proxy implementation/security and Cloudflare free quotas must be verified in its deployment task. Proxy has no inference/auth logic; don't expose secrets or store session state on Pages. Must preserve request IDs, Set-Cookie, location, origin and body handling safely.
- **Backup deployment if proxy reliability fails:** Serve compiled React static assets from Express on a **single Render Free origin**; initial cold load may be slow, but avoids broken third-party cookies.
- **Why not naïve Pages + Render direct cross-site cookies?** Third-party-cookie blocking across `pages.dev` and `onrender.com` can break refresh sessions. Do not claim browser-wide reliability without the reverse-proxy test. Avoid requiring a purchased domain (strict ₹0).
- **Render Free** can sleep after ~15 min idle, can restart, has ephemeral filesystem, and may incur charges for overages when a payment method is attached. Choose Free, review spending controls, and keep no paid fallback. Preflight/ready-state before an interview timer starts. Source: https://render.com/docs/free .
- **Atlas Free** is limited storage (~512 MB) and shared resources. Store textual transcripts and structured events efficiently; never raw media by default. Source: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ .

### 3.2 Monorepo structure (target)

```text
ai-interviewer/
├── apps/
│   ├── web/                   # React/TS Vite UI
│   │   ├── src/app/            # router, providers, guards
│   │   ├── src/features/       # auth, interview, voice, coding, results, billing, admin
│   │   ├── src/components/     # reusable UI
│   │   └── functions/api/      # thin Cloudflare Pages proxy, deployed only if verified
│   └── api/                   # Node.js/Express TypeScript API
│       ├── src/config/         # validated environment config
│       ├── src/core/           # middleware, errors, authz, request IDs, metrics
│       ├── src/modules/        # auth, users, interviews, quotas, ai, proctoring,
│       │                       # evaluation, reports, billing, invites, admin
│       ├── src/integrations/   # firebase, groq, cloudflare, brevo, sms, payments
│       └── tests/
├── packages/
│   └── contracts/             # shared Zod/TypeScript API and AI schemas
├── docs/
│   ├── ADR/                   # versioned decisions, concise tradeoffs
│   ├── RUNBOOKS/              # setup, deployments, incident recovery
│   ├── API/                   # contract docs
│   └── TEST_EVIDENCE/         # test logs and measured benchmarks
├── prototypes/               # archived references; not deployed directly
├── .github/workflows/         # zero-cost CI, if available
├── package.json              # npm workspaces for simple onboarding
├── .env.example              # placeholders only
└── README.md
```

Choose **npm workspaces** rather than adding an unnecessary monorepo orchestrator. `apps/api` may use `tsx` for local TypeScript execution, `tsc` for release builds; keep versions pinned in lockfile. Apply `eslint`, TypeScript strict, Vitest, Supertest, Playwright gradually. Store secrets only in `apps/api/.env` and hosting secrets.

## 4. Backend engineering rules

1. **Explicit resource boundaries:** user ID comes from verified session, never request body; admin privileges only server-side; premium access and own-resource checks enforced for every route.
2. **Deterministic state:** LLM proposes dialogue and evaluations, but backend decides session status, timer, warning severity, credits, score release, report permission, billing and account flags.
3. **Idempotency:** client supplies idempotency key for start/submit/grade; server has unique indexes and a state transition version. Duplicate response/retry returns same outcome.
4. **Quotas:** an atomic `usagePeriods` document for one user + billing period is the authority for used/reserved count. Unique usage operation IDs and an audit ledger prevent double use. Start/reserve/commit/release/refund/reset paths are tested under concurrent requests. Do not depend on in-memory counters.
5. **AI provider failover:** a timed-out/ineligible primary can switch to another **approved free provider** only if privacy class, budget and model-capability constraints permit. Per-request max tokens, max wall time, concurrency and provider budgets. Fail closed without paid calls.
6. **Prompt discipline:** constrain outputs with shared schemas; validate every provider output even if provider reports JSON mode/structured mode. Prompt injection from candidate responses/resumes/README files must not override system policy.
7. **Privacy:** camera and audio are not recorded by default. Browser STT may send audio to its vendor; disclose this. Avoid sending personal info to a provider not contractually approved. Support consent, personal-data export/deletion, bounded retention.
8. **Sensitive operations:** OTP hashed/HMAC and short-lived; Argon2id for passwords; rotating hashed refresh tokens; secure HttpOnly cookie; CSRF/origin validation; rate limiting; logged admin overrides. Never print private content in request logs.
9. **Telemetry:** per AI request `provider,model,purpose,inputTokens,outputTokens,latencyMs,attempt,rateLimitStatus,correlationId` (not raw answers). Alert via admin dashboard when free quota approaches exhaustion.
10. **Testing:** unit + API integration + concurrency + browser E2E + security + provider-mock tests. Real API or provider tests are manually enabled and bounded to protect free quotas.

## 5. Interview experience: complete behavior

### 5.1 Interview configuration / preflight

- Choose Practice or Assessment; role/stack/topics autocomplete; technical/behavioral/mixed, optional coding share; weighted topics = exactly 100%; difficulty fixed/adaptive; time share; editable preview without disclosing questions.
- Free plan forces 15 min and basic topic choice. Paid/VIP can select 10–60 min and premium resume/JD/repo inputs.
- Check entitlement + active cooldown + available quota + global AI capacity before issuing a reservation. Validate microphone/camera/fullscreen permissions in preflight. **No credit committed or timer started during preflight/backend cold start.**
- Create backend `READY`/`ACTIVE` transition; first actual question is the credit-commit boundary. Recovery uses persistent `interviewId` and same credit ID.

### 5.2 AI dialogue and voice

- Browser: `SpeechRecognition` + Silero speech-start/turn-end detection + Kokoro playback; when user interrupts during playback, cancel current audio, record barge-in event, start fresh candidate transcription and ignore stale AI output using turn generation/cancel IDs.
- Backend controls turn sequence. AI gateway has purpose-specific calls: prepare an interview plan, generate one question/follow-up, evaluate completed answer, optionally synthesize a final coaching report. Do not run evaluation on every partial transcript.
- High-speed follow-ups use short bounded context (last 4–8 turns + structured interview summary + current question rubric); no endlessly expanding transcript in every prompt. For question-level scoring include only relevant answer, rubric, and optionally minimal context.
- Groq primary model ID `qwen/qwen3.8-27b`, reasoning effort `none` or low for live dialogue **after testing accepted parameters**; use stricter/high-quality model mode as needed for evaluator. Cloudflare model `@cf/qwen/qwen3.8-27b` fallback with provider-specific adapter. Model equivalence does not mean identical behavior.
- Optional manual `Done answering` and transcript correction; visible mic/AI/processing/recovering states; always distinguish AI speech from user transcript.
- Test degraded browsers and fallback explicitly; on-device Web Speech mode where available is a future improvement, not prerequisite to build.

### 5.3 Persistence and recovery

- Persist interviews, questions, finalized turns, code snapshots, evaluation results and grouped integrity events; server controls `startedAt`, `deadlineAt`, `pauseAllowance`, `lastSequence`, `stateVersion`.
- On reconnect verify current user owns interview, check deadline and integrity status, restore last committed event/state and re-run mic/camera/fullscreen preflight.
- Bounded recovery for network or server failures, without wrongly labeling loss of connectivity as cheating; system-caused abort can restore a credit. User-initiated cheating termination remains consumed.
- If AI provider is unavailable, pause turn processing with capped retries and an explicit error; no looping paid inference. Maintain truthful statuses.

### 5.4 Anti-cheat rules: do not simplify away the user's requirements

| Trigger | Policy |
|---|---|
| Normal violations | **5 yellow**, then **2 red**, terminate on next qualifying violation; severe issues may start at red. |
| Fullscreen exit | ~3 sec grace, then log grouped incident; tab switching after grace considered contextually. |
| Mic/camera disconnect | Pause immediately; yellow and 30 sec recovery; then red and 45 sec additional recovery; unresolved terminate. |
| Face absent | Continuously absent 5 sec → red; 3 sec return window; unresolved terminate. |
| Multiple faces | Immediate red (robust false-positive checks). |
| Looking away | Context-sensitive; never automatic guilt from gaze alone. |
| Other voices/noise | Distinct persistent yellow incident; new incident only after 10 sec continuous silence. |
| Clipboard | Flag unusual paste for context; no automatic cheating verdict from paste alone. |
| Repetition | Group related detections, highest severity per incident; backend does not apply repeated penalties each frame. |
| Terminated | Preserve session + integrity log; no normal completed interview score; 15-minute server-enforced cooldown; consumed credit. |

No continuous video/audio recording. Client camera observations are untrusted hints; backend applies policy but cannot guarantee proctoring integrity in a browser. Provide manual review/reset by authorized admin with an audit reason.

### 5.5 Coding interview

Monaco supports Java, JS, TS, Python, C++. Candidate can edit snippets, discuss reasoning by voice, receive conceptual or debugging challenges. Persist periodic change snapshots/versions. AI reports approach, time/space complexity, correctness concerns and suggested fixes. **No remote code execution or claimed passed tests** in this release; that would require a secure sandbox and is explicitly deferred.

### 5.6 Evaluation, result and paywall

- Create a per-question rubric before grading. Grade 0.0–10.0, one decimal. Concise correct answers eligible for 10/10; don't penalize verbosity or writing style arbitrarily. Keep technical scoring distinct from integrity incidents.
- On valid completion, compute transparent average out of 10 from scored questions (explicit documented weights; avoid arbitrary hidden penalties). Only release aggregate after all required graders resolved or mark partial evaluation state with clear indication.
- **Free UI and API:** overall score only, premium details not fetched/not sent. Clicking report detail opens upgrade dialog. Free personal-data export still available through separate privacy route.
- **Paid/VIP:** question-by-question scores, correct/incorrect reasoning, exactly what improves answers toward 10/10, optionally better solutions, transcript, coding review, downloadable PDF, analytics and personalized next steps. Successful upgrade can unlock prior completed reports, if data exists.
- Report generation should be reproducible and cached: no extra AI re-generation simply because user clicked a report.

### 5.7 Resume, JD and GitHub premium personalization

- PDF and DOCX text extraction, size/page limits, reject malicious files, avoid arbitrary executing embedded content, browser-side extraction where feasible. User reviews extracted skills before session creation.
- JD input is treated as untrusted content; normalize and limit. Compare role requirements with resume evidence, derive editable topic/weight proposals; don't invent qualifications or falsely claim ATS endorsement.
- Public GitHub repo analysis fetches a bounded allowlisted subset of text/code/README/manifest files, avoids secrets/binary/large files, caches structured summaries and never executes repo code. Respect unauthenticated API limit (60 req/hour for public GitHub REST by IP) and privacy rules.
- Premium coach supports retrying related concept, improvement comparison, weak-topic recommendations, multi-round mock onsite and performance trends. Build **after stable baseline**; do not block free core launch.

### 5.8 Admin + invitation + sandbox billing

- A bootstrap super-admin seeded from a local deployment secret/manual script; cannot be self-assigned from registration. All protected routes use RBAC and audit user/target/action/reason/request ID.
- Admin can inspect user metadata, quota period, active interview state, results summaries, payment-test events, AI token use, integrity events; modify plans/credit balance/VIP expiry, suspend/reactivate, delete data, issue/revoke email-bound expiring single-use invites. Access to private transcripts/resumes only via special audited support workflow.
- Registration mode `PUBLIC | INVITE_ONLY` independent of entitlement `FREE | STARTER | PRO | PREMIUM | VIP`.
- Billing adapter `BillingProvider` with sandbox checkout, verified signed webhook, idempotent delivery, reconciliation and subscription lifecycle; no chosen production gateway/no real charges. Price tiers are data and displayed as clearly simulated.

## 6. Phase-by-phase execution roadmap

**Priority labels:** P0 mandatory for a compelling live interview MVP; P1 core complete product; P2 optional differentiators. **Completion** means code + tests + documented evidence + manual path. Durations are task estimates only after work is sized; no arbitrary calendar promise.

| Phase | Scope | Priority | Main dependencies | User-visible result / exit gate |
|---|---|---|---|---|
| **1. Foundation** | Monorepo, React/API, schema contracts, config, DB, logging, CI | P0 | None | `web` + `api` run locally; health/ready endpoints, tests, lint/typecheck, secure env setup. |
| **2. Identity** | Firebase Google Sign-In, custom email/password, OTP, sessions, RBAC, profile, privacy consent | P0 | 1 | Both login flows work, account linking secure, auth bypass tests fail. |
| **3. Access & quotas** | Plan catalog, Free quota, VIP entitlement, atomic usage, premium gates, admin bootstrap | P0 | 2 | Free quota used once; reset/termination/refund/race tests. |
| **4. AI + interview controller** | Provider adapters, health/budgets, interview planning, turn state machine, checkpoints | P0 | 1–3 | Real text interview with Qwen, deterministic turns, measured tokens, safe failover. |
| **5. Voice vertical slice** | Migrate Kokoro/VAD/browser STT, barge-in, preflight, recover; local media cleanup | P0 | 4 | End-to-end login → 15-min voice interview; interrupts/retries; actual browser tests. |
| **6. Integrity monitoring** | Fullscreen/camera/audio/paste incidents, warning severity, cooldown | P1 | 4–5 | Policy thresholds unit tested; false-positive scenarios manually reviewed. |
| **7. Evaluation/results** | Rubrics, scoring, free aggregate, premium report schema, transcript/PDF | P0 | 4–6 | Free sees only /10; paid/VIP sees detailed report; no leak via API. |
| **8. Coding + customization** | Monaco, question/code snapshots, resume parsing, JD, GitHub repo bounded analysis | P1 | 4–7 | Save/recover code; premium tailored interview; no executable sandbox. |
| **9. Premium analytics/coach** | Topic mastery, compare attempts, learning plans, multi-round simulation | P1 | 7–8 | Targeted practice + honest progress trend. |
| **10. Billing/Admin/Invitations** | Test payment adapter, webhooks, plan changes; full admin UI; VIP email invitations | P1 | 2–9 | Admin override + audit, VIP no-charge unlock, sandbox billing lifecycle demo. |
| **11. Hardening & deployment** | Load/privacy/security, accessibility, threat-model review, observability, hosting | P0 closeout | 1–10 | Private HTTPS demo, runbooks, test evidence, recruiter walkthrough. |

**Practical delivery sequence:** Build a **thin vertical slice** by Phase 5, not every subsystem in isolation. Finish Free scoring and quota before investing heavily in Pro extras. Admin operational APIs needed for testing may be added earlier than Phase 10; full dashboard is later.

## 7. Detailed phase requirements and acceptance gates

### Phase 1 — Foundation [START NOW]

**Tasks:** initialize Git/monorepo npm workspaces; strict TS, ESLint and formatting; Vite React app; Express API with middleware and versioned routes; Zod config and contracts; Atlas/Mongoose connection readiness; dependency injection for provider stubs; local Vite `/api` proxy; env examples; Vitest/Supertest unit/integration; CI plan; README; standard errors and correlation IDs.

**Acceptance:** run `npm install`, `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`. Local React page calls `GET /api/v1/health/live` and displays API status. Missing optional third-party secrets do not crash local dev; missing production security settings fail clearly. Production startup refuses invalid configuration. API doesn't log headers/secrets. Route with unhandled exception returns safe error and request ID. `ready` reports false when required Atlas connection unavailable. **See `docs/PHASE_01_CODING_BRIEF.md` for exact file/task sequence.**

### Phase 2 — Authentication/Identity

**Tasks:** Mongoose user and identities, passwords table/identity; Firebase Admin verified ID-token exchange; custom email/password registration/login; Argon2id benchmark on Render Free before concurrency; Brevo HTTPS OTP verify/reset/resend; refresh/access token session rotation and revocation; link Google to custom account after proof of ownership; per-IP/account rate-limiting; optional phone-OTP test adapter; account/profile deletion request and consent version; seeded admin role.

**Acceptance:** Google and custom accounts both reach same app user; wrong/expired/used OTP fails; reset invalidates relevant sessions; refresh replay revokes family; CSRF and cross-origin tests; no password/OTP in logs; user A cannot access B; forged Firebase ID tokens fail; role escalation impossible. Firebase Google remains in the UI. SMS real delivery may be deferred ONLY due to permitted paid exception.

### Phase 3 — Entitlements/Quota

**Tasks:** plan definitions and billing periods; atomic `usagePeriods` + ledger; one Free 15 min/calendar month; paid 10/25/50 billing periods; VIP unrestricted count but global admission; reserve/commit/release/refund/reconcile, admin adjustments and cooldown; feature guards and paywall errors.

**Acceptance:** 100 concurrent simulated attempts by one Free user produce **at most one** successful active reservation/committed credit. Abandoned preflight doesn't charge. Verified platform failure refunds exactly once. Integrity termination consumes. Free result detail API returns authorization error/upgrade metadata, **not** confidential detail. No paid billing dependency yet.

### Phase 4 — AI Gateway + Interview Core

**Tasks:** provider interface with `generateStructured`, `generateTurn`, usage record, abort/timeouts; Groq Qwen 3.8 27B, Cloudflare Qwen 3.8 fallback; model IDs env-configurable; schema-driven questions/rubrics; prompt context summary; state transitions and server deadlines; retry semantics and event sequence; provider-limits/429 handling; live metrics dashboard API restricted to admin.

**Acceptance:** real Groq test confirms structured, sensible questions and follow-ups; short prompt returns validated JSON; provider failures do not lose committed responses; explicit 429 triggers only eligible fallback or safe pause; failed/old generation ignored. Daily hard budget stops new inference. Test with mock providers for 100% reproducible CI. **Existing 16 Qwen calls do not prove scoring.**

### Phase 5 — Voice

**Tasks:** migrate voice POC with original working libraries/versions; React feature and lifecycle service, Silero VAD speech-start/end, Web Speech transcripts, Kokoro warm/cache, interruption cancel tokens, ring-buffer if technically feasible, device status/error handling; endpoint link to stateful interview; restart/recovery and manual corrections.

**Acceptance:** live 15-minute voice session on Chrome with 5+ real follow-ups, interrupts, stable transcript, no duplicate turns or stale audio. 30/60 min browser soak later; Chrome STT online dependence explicitly disclosed. Test headphone and speaker scenarios, model first-download vs warm runs. No new TTS cloud expense.

### Phase 6 — Integrity

**Tasks:** client proctoring using MediaPipe, fullscreen, visibility/tab events, microphone/camera status, clipboard patterns; backend incident policy state, grouping, warning UI, receipt, admin review; cooldown.

**Acceptance:** reproduce exact thresholds/return windows including 3-sec fullscreen, 30+45 sec mic/camera, 5+3 sec face absent, immediate red multi-face. Integrity termination never emits completed score. False positives and accessibility documented. No raw video stored.

### Phase 7 — Scoring and Reports

**Tasks:** internal question rubric, evaluator schema, score review benchmark, final aggregation, free-only result DTO, premium annotated report builder and PDF export, upgrade unlocks previously scored interviews; data export route independent of paywall.

**Acceptance:** 10/10 possible for canonical concise correct answers; rubric comparison test suite with weak/strong/ambiguous answers; duplicate evaluation doesn't re-charge or overwrite; Free data cannot be obtained via network payload; premium report PDF readable and consistent with stored evaluations.

### Phase 8 — Coding + Resume/JD/GitHub

**Tasks:** Monaco persistence, semantic code snapshots, PDF/DOCX extraction, JD matching, topic suggestion, bounded GitHub file retrieval and summarization, content size/time budgets, prompt-injection guards, private data treatment.

**Acceptance:** resume extraction tested for multiple formats; error on oversized/unparseable files; GitHub code never executed; no token secrets exfiltrated in summaries; per-interview code state survives reconnect; detailed code review explicitly says static analysis, not executed tests.

### Phase 9 — Analytics and Improvement Coach

**Tasks:** aggregate per-topic trends, fair comparability filters, weak-topic re-interviews, answer before/after comparisons, preparation plan generation, multi-round interview orchestration. No fake readiness certainty.

**Acceptance:** trends can be reconstructed from persisted scores, data deleted on privacy request, no double-counting from repeated evaluations; feature guards work for Free.

### Phase 10 — Billing sandbox + Admin + VIP

**Tasks:** gateway-agnostic billing adapter with safe test-provider selection; webhook verify/dedupe/reorder; subscription transition table; admin users/credits/flag/suspension/deletion/payment/AI usage; secret-safe audit; invite issuance + email verification + single redemption; VIP expiry and revocation.

**Acceptance:** replay webhook 100 times = one subscription change; free user cannot self-upgrade; admin quota adjustment logged with reason; VIP invite one use/expiry/revoke; private user content only visible through approved audited support access; **real charge disabled**.

### Phase 11 — Quality, deployment and recruiter demonstration

**Tasks:** threat model, review dependencies/secrets/CORS/CSRF, cookie same-origin proxy validation, memory/performance and 15/30/60 min soak, global-budget shutdown, rollout docs, runbook, accessibility checks, manual E2E, benchmark report and recruiter demo fixtures.

**Acceptance:** demo reliably illustrates Free paywall, Premium reporting, admin override, VIP invite, one natural voice interview, persisted recovery and sandbox billing. README includes architecture diagram, known limitations, real test commands and screenshots. No fabricated claims about commercial availability or unlimited capacity.

## 8. Delivery/checkpoint discipline

Each work item must include: **task ID, intended files/modules, exact behavior, non-goals, input/output contract, tests, security invariants and proof of execution**. An agent may implement but must report file list, commands run, outputs, known issues, and whether a manual browser test occurred. Reviewer must verify critical routes and state transitions against docs before merging. Do not mark tests passed if dependencies could not install or external services were unavailable.

**Suggested per-commit tags:** `P1-FND-01` etc. **Merge gates:** no type errors; unit/integration pass; no leaked env; API contracts reviewed; security-impacting changes tested; docs updated. Use CI only where a no-cost runner is legitimately available.

## 9. Measurable quality targets (not yet achieved)

| Domain | Initial target | Measurement |
|---|---|---|
| Voice | Low-latency, natural barge-in; no stale AI audio after interruption | p50/p95 answer→audio with real inference, manual user test |
| Inference | Deterministic JSON contract + bounded token use | response schema pass rate, prompt/output tokens, 429 rates |
| Evaluation | Evidence-backed 0–10 consistency; avoid fabricated certainty | golden-answer comparison reviewed by human |
| Quotas | Zero double reservations under concurrent start | parallel integration tests + uniqueness assertions |
| Sessions | No duplicate question/score after refresh | retry/replay E2E tests |
| Privacy | No media stored; no premium leak to Free | API tests and storage/log audit |
| Admin | All sensitive actions authenticated, authorized, logged | permission matrix and audit tests |
| Cost | Zero paid LLM/host/TTS/database events | provider plan review + budget guard simulation |

## 10. Open risks accepted for coding (not blocking Phase 1)

- Actual 15–60-minute live LLM+STT inference capacity, multi-user concurrency and cloud fallback privacy need stage tests.
- SpeechRecognition vendor dependence: local speech recognition may be possible in some browsers but is not currently enabled; privacy disclosure and consent required.
- Cloudflare Workers AI Qwen availability and precise per-model neuron accounting may change. Keep fallback feature-flagged until free-plan integration test.
- Render Free disk/spin-down and cookie proxy are deployment gates.
- MongoDB Atlas Free storage limits require retention/size monitoring; app must not rely on free Redis persistence.
- Camera/audio proctoring has false positives and is circumventable in-browser. Do not market as proof of misconduct.
- Real subscription pricing could not support guaranteed quotas on unpaid AI infrastructure. **Sandbox only**.
- Administrative data access must remain privacy-respecting, even if the owner wants rich operational visibility.

## 11. What to do now

**Immediate coding command:** Open `docs/PHASE_01_CODING_BRIEF.md` and implement tasks **P1-FND-01 → P1-FND-08** in a fresh repository. Place the archived voice prototype under `prototypes/`, not deployed as-is. When Phase 1 tests pass and the file/command evidence is supplied, advance to the custom/Firebase authentication implementation.

**Do not ask the user to pick libraries or host providers again** unless an external requirement invalidates an already-selected option. This document is the execution baseline; change it through an explicit numbered ADR, not another broad brainstorm.
