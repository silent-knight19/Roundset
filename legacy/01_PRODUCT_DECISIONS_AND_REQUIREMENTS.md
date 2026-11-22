# AI Interviewer — Canonical Product Decisions and Functional Requirements

**Version:** 1.0 — 2026-11-22
**Status nomenclature:** **[DECIDED]** user explicitly specified or accepted; **[PROPOSED]** engineering default from prior planning, still subject to audit; **[PENDING]** not decided/validated; **[TESTED]** actually validated in a prototype. Unless explicitly marked otherwise, feature items below are planned, **not yet coded**.

## A. Purpose, audience and quality bar

- **[DECIDED]** Full-stack AI-powered interview practice/assessment site, voice-first, for technical and behavioral interviews, tailored to role/stack/skills/resume/JD, with coding interview support, question-wise evaluation, progress analytics and downloadable reports (premium).
- **[DECIDED]** Resume-quality engineering: reflect practical backend depth, secure authentication, subscriptions, data consistency, testing, reliability and documented tradeoffs—not merely a visually polished AI wrapper.
- **[DECIDED]** Private/demo-first app with carefully controlled registration/invitations and administrator oversight; may demonstrate public signup/free/paid plans in sandbox.
- **[DECIDED]** Service expenditure zero except possibly small SMS OTP provider credits. No paid AI or hosting even for development unless user explicitly changes this global constraint.
- **[DECIDED]** User gives high-level product direction; principal architect (ChatGPT) selects standard engineering defaults without repetitive multiple-choice loops.

## B. Interview configuration and preflight

- **[DECIDED]** Two modes: **Practice** and **Assessment**. Both require microphone, camera and fullscreen.
- **[DECIDED]** Technical, behavioral or mixed interviews; candidate may allocate fractions between types, and optionally allocate a coding-round portion.
- **[DECIDED]** Select roles, technologies, topics via editable multi-select with autocomplete; optionally upload resume (PDF/DOCX) for skill identification and edit suggested topics, or paste/upload job description where entitled.
- **[DECIDED]** Multiple topic weights totaling 100%; flexible time allocations; fixed or adaptive difficulty; preset interview durations 15/30/45/60 min and custom 10–60 min **subject to plan-specific limits**.
- **[DECIDED]** Show an editable, pre-interview **plan preview** containing round distribution and topic/time settings, not the actual question text.
- **[DECIDED]** Real-time voice is primary; visible transcription and manual correction/text fallback remain available. Manual “done” control can complement automatic end-of-answer detection.
- **[DECIDED]** Free plan overrides the general configuration duration with a fixed 15-minute session; paid/VIP can select 10–60 min (60-min deployment success still needs testing).
- **[PROPOSED]** Preflight device checks and backend wake-up before consuming credits or starting countdown.

## C. Interview intelligence and conversation

- **[DECIDED]** LLM question planner, dynamic interviewer, adaptive follow-ups and evaluator, but state transitions/timer/credits/terminations remain under deterministic backend control.
- **[DECIDED]** Interviewer should ask relevant clarifying/follow-up questions, adapt difficulty and topic depth, remember prior statements, allow rephrasing/repeating and preserve interview context on reconnect.
- **[DECIDED]** No answer leaks in Assessment; appropriate hints in Practice mode.
- **[DECIDED]** Candidate can speak naturally and **interrupt AI in mid-sentence**. Automatic speech-to-text and end-of-turn detection required; manual input fallback.
- **[TESTED]** Scripted voice demo with local Kokoro + Silero VAD + browser SpeechRecognition worked well for user; this is not evidence of real Groq LLM conversational quality.
- **[PROPOSED]** Structured outputs, question-state identifiers, summaries for context compression, safeguards for hallucinations and rubric relevance.

## D. Anti-cheating and integrity — preserve exact policy

**[DECIDED] Severity escalation**
- Normal incidents: **5 yellow warnings**, followed by **2 red warnings**, then terminate on the next qualifying violation. The sequence is per interview; display warnings clearly.
- A severe offense may **jump directly to red** without consuming a prior yellow sequence.
- Repeated/related detections are **grouped into one incident**, assigned the highest applicable severity; do not spam warnings each frame or audio chunk.
- Two red warnings already issued -> next qualifying incident may terminate. Do not downgrade a severe offense merely to make sequence more gradual.

**[DECIDED] Concrete scenarios**
- **Fullscreen:** mandatory. If exited, grant ~3 seconds grace; unresolved exit becomes integrity incident. Record suspicious tab/window switching after the grace. Never equate unavoidable browser behavior with proof of cheating.
- **Camera and microphone disconnection:** pause interview immediately; **30 s recovery** and yellow warning; unresolved escalates to **red plus another 45 s**; unresolved thereafter terminates.
- **Face missing:** continuous absence for **5 s** -> red warning, plus **3 s** return window; unresolved then terminates. Use debounce/robust detection; interpret with care.
- **Multiple faces:** immediate **red** warning, with false-positive handling in implementation and auditable evidence.
- **Looking away:** context-aware detection; do not treat natural thinking, reading code or accessibility-related gaze as certain misconduct.
- **Other person/background voice or noise:** yellow for distinct persistent incidents; require **10 continuous seconds of silence** before counting a subsequent incident.
- **Unusual clipboard paste:** flag/contextual review; do not auto-conclude cheating based on paste alone.
- **Repeated incidents:** highest severity event wins per group; persistent/repeated breaches escalate under warning policy.
- **Termination:** interview record survives with appropriate integrity status; no ordinary completion score/report that implies a normal interview. **Mandatory 15-minute cooldown** before a new interview; cooldown server-enforced across reloads/devices. No permanent account bans as default.
- **Privacy:** process face presence/head pose locally (MediaPipe); do not retain raw webcam footage by default or claim emotion/guilt detection. Keep logs proportional to integrity events.
- **[PROPOSED]** Admin can view and override integrity restrictions where justified, with an audit event; do not allow hidden, unlogged privilege changes.

## E. AI evaluation and feedback

- **[DECIDED]** Privately score **every interview question 0.0–10.0**, one decimal place. A fully correct concise answer must be eligible for **10/10**.
- **[DECIDED]** Scoring follows question- and topic-specific rubrics. Evaluate reasoning, correctness, clarity, completeness and, for code, complexity/tradeoffs; avoid arbitrary mark deductions. Do not punish reasonable concise responses for not matching one model answer.
- **[DECIDED]** Aggregate score is evidence-backed; report scores only after completion; separate integrity events from technical competence.
- **[DECIDED]** Premium detailed report: full chronological question/answer/follow-up transcript, each question score, concrete positives and errors, precise “what would improve it to 10/10”, context-dependent improved/model answers, coding approach/code-review findings, weaknesses, follow-up resources/plan, and downloadable PDF.
- **[DECIDED]** Free user sees **ONLY the overall/average score out of 10**, with detail locked behind a paywall. No individual question scores, detailed improvement text, premium PDF or full enriched report in Free UI.
- **[DECIDED]** Premium upgrade should unlock **earlier completed interview reports** wherever valid evaluation data exists, not only future reports. However, a terminated-for-integrity interview still is not a normal completed interview.
- **[DECIDED]** Basic privacy rights (access/export/delete of one's own stored personal data) must NOT be paywalled even if premium report formatting/feedback is locked.
- **[PROPOSED]** Internal golden-answer benchmark, model consistency tests, strict structured evaluator schema and review of disputed scores.

## F. Coding interview workspace

- **[DECIDED]** Monaco editing workspace with Java, JavaScript, TypeScript, Python, C++.
- **[DECIDED]** Supports DSA, debugging and practical snippets; AI can ask questions while candidate codes; preserve editor state and revisions; report code, approach, data structures, time/space complexities and corrections.
- **[DECIDED]** At this phase **no actual remote code execution**; do not imply code passed tests. Static reasoning/analysis only. Executing untrusted code is a separate future security-sensitive project decision.
- **[DECIDED]** Code and snippets are part of the user data/privacy model.

## G. Resume, JD, repository and personalization

- **[DECIDED]** Resume upload PDF/DOCX, extract text/skills/projects/experience (proposed libraries: PDF.js and Mammoth.js), let candidate accept/edit topics. Job-description input and role/skill matching.
- **[DECIDED]** Premium-gated advanced resume/JD intelligence and JD-targeted interview setup; free tier can manually pick basic topics.
- **[DECIDED]** Premium can include public GitHub repository deep-dive interviews: selected code/architecture analysis, API and security decisions, scalability and concrete project-specific questions.
- **[DECIDED]** Premium AI answer coach/retries, multi-round mock onsite, skill mastery analytics, individualized learning plans, enhanced technical and behavioral feedback.
- **[PROPOSED]** Premium interviewer personas, behavioral STAR story bank and coding-solution evolution views are lower-priority enhancements; implementation may be phased after core product.
- **[DECIDED]** User content may contain personal/confidential data. Do not send identifiable resumes, private repository contents or candidate voice to an unpaid provider whose terms restrict that use.

## H. Dashboard and history

- **[DECIDED]** History of interviews, completed and terminated segregated, scores/results where entitled, weak-topic trends, chart-based analytics, prior attempt comparisons and re-interviews.
- **[DECIDED]** Paid/VIP sees advanced longitudinal performance, topic mastery, readiness and intelligent practice recommendations; Free sees allowed summary and own basic history, with premium details locked.
- **[PROPOSED]** Recharts for graphs; compare like-for-like interviews (topic/difficulty/duration) where meaningful.

## I. Free/Paid/VIP subscription plans — most recent user decision overrides earlier ideas

| Tier | Monthly price | Credits/month | Interview duration | Premium feature entitlement |
|---|---:|---:|---|---|
| **FREE** | ₹0 | **1** | **Exactly 15 min** | No: overall score /10 only, basic topic setup |
| **STARTER** | **₹250** | **10** | Custom **10–60 min** (subject to technical validation) | Yes |
| **PRO** | **₹500** | **25** | Custom **10–60 min** | Yes |
| **PREMIUM** | **₹1,000** | **50** | Custom **10–60 min** | Yes |
| **VIP / DEMO** | ₹0 (invited by admin) | No app-level count cap | Custom **10–60 min** | Yes; obey global infrastructure limits |

- **[DECIDED]** All three paid plans unlock **exactly the same premium features**. **Only monthly interview count differs.** This supersedes the earlier drafted Free 2×15 min and Pro 120 min/month model.
- **[DECIDED]** Free limit **one 15-min interview per calendar month**; paid plans renew each monthly billing period. Unused credits do **not** carry forward (proposed default).
- **[DECIDED]** An interview intentionally terminated under anti-cheat consumes the credit, including the sole free one. Timer/reload does not reset quota or cooldown.
- **[PROPOSED]** Reserve a credit on session creation and consume at first actual question; release on preflight abort; restore on verified platform-side failures; idempotent backend quota ledger handles retries and concurrent starts.
- **[DECIDED]** All prices are **product/sandbox plan specifications**, not permission to enable real paid transactions. Payment provider not chosen. Enable test-mode checkout/billing subscription lifecycle first, *no real charges*.
- **[DECIDED]** Hard global free-AI capacity ceilings always override user entitlement; '50 interviews' is not a verified service-level guarantee until quotas and latency are measured.
- **[DECIDED]** Paywall on clicking locked detail with clear upgrade benefits, without leaking sensitive report details through API payloads.

### Which features are premium-only?
Detailed per-question scoring, concrete mistakes and improvements, transcript-enhanced reports/PDF, improved model answers, resume/JD uploads and JD-specific questions, GitHub repository analysis, AI answer coach, skill mastery/advanced analytics, full mock onsite simulation, learning plans, richer interviewer personas (proposed). Basic voice, anti-cheat fairness/security and correct overall scoring stay Free.

## J. VIP invitation and registration controls

- **[DECIDED]** Admin can invite an email address, assign VIP full access with no payment, and optionally set an expiry/revoke it. Useful for recruiters, mentors and demonstrations.
- **[DECIDED]** Invite tokens cryptographically random, single use, expire, bound to recipient email; recipient signs in and proves email ownership; invite is *not* itself a login credential.
- **[DECIDED]** Registration visibility (public signup vs invite-only admission) and feature entitlement (Free/Paid/VIP) are **separate switches**. Allows private deployment without disabling regular auth UX.
- **[PROPOSED]** Invitation audit logs, maximum redemptions one, reusable invite templates for demo periods, idempotent redemption.

## K. Administrator console

- **[DECIDED]** Separate protected admin UI, full operational control: user directory and profile; registrations, activity, interview list/states/results, subscription/payment/test records; grant extra interview credits; set plan, extend/expire VIP; invitations and revocations; suspend/reactivate accounts; delete user data; monitor API errors, quotas, performance and integrity incidents.
- **[DECIDED]** Admin should have detailed visibility into a user's operational status and usage, but **not** passwords, hashes, OTP secrets, refresh tokens, raw browser camera feeds or card credentials. Sensitive transcripts and resumes require explicit, justified, audited admin/support authorization—never invisible arbitrary access.
- **[DECIDED]** Audit every sensitive admin action; server-side RBAC. Admin role must not be user-editable and must not be granted via frontend-only flags.
- **[PROPOSED]** Dashboard metrics: user count, registrations, interviews, paid subscriptions (simulated), conversion, quota usage, AI token usage/latency, errors, incident trend and invites.
- **[PROPOSED]** Feature flags, plan configurations and maintenance-mode switches adjustable only through admin with validation and audit.

## L. Reliability and recovery

- **[DECIDED]** Backend-authoritative interview timer; refresh/reconnect cannot extend time.
- **[DECIDED]** Auto-save committed turns, evaluation, code snapshots, integrity state and progress; recover after browser crash, network dropout and AI provider failures.
- **[DECIDED]** Idempotent answer/evaluation submission; no duplicated questions, scores or credit consumption. Correct cleanup on stop/timeout.
- **[DECIDED]** On resume: reauthenticate ownership, restore checkpoint and conversational context, rerun camera/mic/fullscreen checks, restore cooldown and incidents.
- **[DECIDED]** Infrastructure outage should not silently count as cheating; record reason/evidence and apply appropriate pause/refund policy.
- **[PROPOSED]** MongoDB persistent checkpoints and ordered event timeline; IndexedDB pending local corrections; client state Zustand, server state TanStack Query. Avoid storing raw camera/audio by default.
- **[PROPOSED]** AI provider circuit breaker, capped retries and system capacity admission control.

## M. Out of scope / deferred

- Real payments or real-money subscriptions (until provider selection and sustainable usage economics).
- Any infrastructure or AI service requiring non-SMS spend.
- Production-scale multi-tenancy and 'unlimited' provider usage claims.
- Remote execution of submitted code.
- Continuous camera/video recording or face identification/diagnosis.
- Unconditionally using Gemini Live for private interviews under unpaid API terms.
- Committing to specific LLM/rate limit numbers as permanently valid without reading active account quotas.
- Falsely advertising fully automatic natural conversation based on a scripted/demo-only test.
