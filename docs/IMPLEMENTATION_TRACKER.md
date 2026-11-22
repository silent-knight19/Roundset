# AI Interviewer — Implementation Tracker

**Last snapshot:** 2026-11-22. `[ ]` is unimplemented/unverified; `[x]` is supported by actual evidence. Do not mark complete from docs alone.

## Previously completed feasibility work

- [x] Voice prototype archived: React + Kokoro + Silero VAD + browser speech recognition.
- [x] User manually tested scripted voice flow and reported excellent naturalness; screenshot captured successful barge-ins.
- [x] Basic Groq Qwen API usage captured (16 successful calls, no full-session benchmark).
- [x] Product requirements consolidated in legacy files and roadmap.
- [x] Initial official vendor research + ADRs documented.

## Phase 1 — Foundation (START NOW)

- [ ] P1-FND-01 Monorepo, npm workspaces, TS strict, ESLint, lockfile.
- [ ] P1-FND-02 Express API factory, health/live+ready, errors, request IDs.
- [ ] P1-FND-03 Zod shared contracts package.
- [ ] P1-FND-04 Mongoose connection manager and readiness.
- [ ] P1-FND-05 React/Vite route/UI shell and dev proxy.
- [ ] P1-FND-06 API/frontend tests, build/lint/typecheck and CI.
- [ ] P1-FND-07 Validated config, env/redaction, session-origin ADR.
- [ ] P1-FND-08 README, architecture docs, evidence, reviewed first commit.

## Phase 2 — Identity

- [ ] P2-AUTH-01 Users/identities/session models and indexes.
- [ ] P2-AUTH-02 Firebase Google ID token verification + app session.
- [ ] P2-AUTH-03 Custom email/password Argon2id registration/login.
- [ ] P2-AUTH-04 OTP verify/reset/resend, email mock + Brevo HTTP integration test.
- [ ] P2-AUTH-05 Rotating refresh JWT/session, revocation, CSRF, abuse limits.
- [ ] P2-AUTH-06 Phone OTP provider mock and optional real SMS integration.
- [ ] P2-AUTH-07 Account linking, profile/privacy/reauth, security tests.

## Phase 3 — Entitlement and quotas

- [ ] P3-ENT-01 Plan catalog Free/250/500/1000/VIP.
- [ ] P3-ENT-02 Atomic quota reservation/commit/release/refund/period reset.
- [ ] P3-ENT-03 Premium guards, cooldown gate, admin seed/override API.
- [ ] P3-ENT-04 Concurrency, abuse and replay tests.

## Phase 4 — AI and interview controller

- [ ] P4-AI-01 Provider interface, Qwen Groq implementation, mock adapter.
- [ ] P4-AI-02 Cloudflare same-model free-plan adapter and fallback tests.
- [ ] P4-AI-03 Structured prompts/rubrics/schema, context compression.
- [ ] P4-INT-01 Interview state machine, time, event/checkpoint persistence.
- [ ] P4-INT-02 Recovery, timeout, idempotent turns, AI budget admission.

## Phase 5 — Voice integration

- [ ] P5-VOI-01 Migrate tested Kokoro/VAD/STT from archived POC.
- [ ] P5-VOI-02 Connect real interview controller, interruption cancel, cleanup.
- [ ] P5-VOI-03 Live 15-min end-to-end browser test + latency evidence.

## Phase 6 — Integrity monitoring

- [ ] P6-PRO-01 Fullscreen, mic/camera, clipboard and visibility signals.
- [ ] P6-PRO-02 MediaPipe face presence/number, backend incident grouping.
- [ ] P6-PRO-03 All yellow/red escalation, cooldown, false-positive tests.

## Phase 7 — Evaluation and results

- [ ] P7-EVL-01 Question rubrics and 0–10 evidence-backed evaluator.
- [ ] P7-EVL-02 Store scores, calculate aggregate, free result DTO.
- [ ] P7-EVL-03 Premium detailed report, improved answers, transcript, PDF.
- [ ] P7-EVL-04 No-leak tests, evaluation consistency test set.

## Phase 8 — Coding and personalization

- [ ] P8-COD-01 Monaco editor and versioned code snapshots (no execution).
- [ ] P8-RES-01 Resume PDF/DOCX parsing and JD customization.
- [ ] P8-GIT-01 Public GitHub repo bounded analysis.

## Phase 9 — Premium features

- [ ] P9-ANA-01 Skill mastery dashboard / fair analytics.
- [ ] P9-COA-01 Answer improvement coach and weak-topic practice.
- [ ] P9-ONS-01 Multi-round simulated onsite sessions.

## Phase 10 — Admin, VIP and sandbox billing

- [ ] P10-BIL-01 Provider-neutral payment sandbox and webhook inbox.
- [ ] P10-ADM-01 Admin management UI, user info, quotas, audit, AI usage.
- [ ] P10-VIP-01 Secure expiring email VIP invitations and revocation.

## Phase 11 — Final quality and deployment

- [ ] P11-SEC-01 Authz/CSRF/secret/proxy/fullscreen/privacy threat tests.
- [ ] P11-SOAK-01 15/30/60-min long-session soak and recovery.
- [ ] P11-DPL-01 Free-tier deployment + runbooks + truthful recruiter demo.

## Evidence links / change log

| Date | Task | Commit / tested command | Status |
|---|---|---|---|
| 2026-11-22 | Voice scripted POC | User manual test + screenshot archived | Validated scripted mode only |
| 2026-11-22 | Qwen short-turn metrics | CSV with 16 successes (4,690 tokens) | Partial inference validation only |
| 2026-11-22 | Roadmap/research/specification | Markdown documents | Docs complete, code not started |
