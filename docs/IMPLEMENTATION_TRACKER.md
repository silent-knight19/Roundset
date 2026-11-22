# AI Interviewer — Implementation Tracker

**Last snapshot:** 2026-11-22. `[ ]` is unimplemented/unverified; `[x]` is supported by actual evidence. Do not mark complete from docs alone.

## Previously completed feasibility work

- [x] Voice prototype archived: React + Kokoro + Silero VAD + browser speech recognition.
- [x] User manually tested scripted voice flow and reported excellent naturalness; screenshot captured successful barge-ins.
- [x] Basic Groq Qwen API usage captured (16 successful calls, no full-session benchmark).
- [x] Product requirements consolidated in legacy files and roadmap.
- [x] Initial official vendor research + ADRs documented.

## Phase 1 — Foundation (COMPLETED & ACCEPTED)

All Phase 1 foundational engineering tasks (`P1-FND-01` through `P1-FND-08`) have been implemented, verified with automated tests, reviewed by the Principal Architect, and merged into `main` via PR #2 and PR #3.

- [x] **P1-FND-01 — Monorepo, npm workspaces, TS strict, ESLint, lockfile.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Initial bootstrap merged at commit `653f1c5`; lockfile and full-stack dependencies reconciled in commit `1c9be95`.
  - **Evidence:** [`docs/TEST_EVIDENCE/P1-FND-01.md`](TEST_EVIDENCE/P1-FND-01.md) and [`docs/TEST_EVIDENCE/phase-01.md`](TEST_EVIDENCE/phase-01.md).
  - **Verification:** Native npm workspaces (`packages/contracts`, `apps/api`, `apps/web`), Node.js 22 LTS runtime enforcement, strict TypeScript (`noUncheckedIndexedAccess`), ESLint 9 flat config, reproducible `npm ci`, and `npm audit` reporting 0 vulnerabilities.
  - **Limitations:** None for repository foundation.

- [x] **P1-FND-02 — Express API factory, health/live+ready, errors, request IDs.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Implemented under Agent A (`P1-BE-01`), merged via PR #2 at commit `2754ef1` with remediations R1–R3 and CodeQL compliance commit `2105542`.
  - **Evidence:** [`docs/TEST_EVIDENCE/P1-BE-01.md`](TEST_EVIDENCE/P1-BE-01.md).
  - **Verification:** Pure Express application factory (`createApp`) decoupled from HTTP listener; `GET /api/v1/health/live` returning HTTP 200 with minimal version info; `GET /api/v1/health/ready` checking dependency readiness; centralized error handler mapping 400 (`INVALID_INPUT`), 404 (`NOT_FOUND`), 413 (`PAYLOAD_TOO_LARGE`), 403 (`FORBIDDEN`), and 500 (`INTERNAL_ERROR`) with masked error details; unforgeable `crypto.randomUUID()` request IDs attached via `X-Request-ID`. Tested in `apps/api/tests/health.test.ts`, `errors.test.ts`, and `security.test.ts`.
  - **Limitations:** No business endpoints mounted yet; live endpoints restricted to `/health/live` and `/health/ready`.

- [x] **P1-FND-03 — Zod shared contracts package.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Bootstrapped in PR #1 (`653f1c5`), expanded in PR #2 (`2754ef1`), and integrated in PR #3 (`65a2782`).
  - **Evidence:** [`docs/TEST_EVIDENCE/P1-BE-01.md`](TEST_EVIDENCE/P1-BE-01.md) and [`apps/web/TEST_EVIDENCE/P1-FE-01.md`](../apps/web/TEST_EVIDENCE/P1-FE-01.md).
  - **Verification:** Shared `@roundset/contracts` package exporting runtime Zod schemas and inferred TypeScript types for `LivenessResponseSchema`, `ReadinessResponseSchema`, `ApiErrorResponseSchema`, `PlanCodeSchema`, and `InterviewStatusSchema`. Enforces strict request ID validation and rejects malformed payloads. Tested in `packages/contracts/tests/contracts.test.ts` (11/11 tests pass) and `apps/api/tests/contracts-integration.test.ts` (3/3 tests pass).
  - **Limitations:** Contracts cover foundational health, error, plan enum, and interview status shapes; domain entity schemas (users, sessions, questions) deferred to Phase 2+.

- [x] **P1-FND-04 — Mongoose connection manager and readiness.**
  - **Status:** Complete (local mock & disconnected verified; cloud cluster deferred).
  - **PR & Merge Commit:** Implemented under `P1-BE-01`, merged via PR #2 (`2754ef1`).
  - **Evidence:** [`docs/TEST_EVIDENCE/P1-BE-01.md`](TEST_EVIDENCE/P1-BE-01.md).
  - **Verification:** `MongoManager` with 5s bounded server selection timeout; asynchronous non-blocking startup connection; sanitized logging emitting only connection state and fixed diagnostic categories (zero URIs, passwords, or driver exceptions in logs); listener cleanup on error and shutdown; `MOCK_DATABASE=true` permits mock readiness for local testing with visible warning banner; production guardrail strictly rejects `MOCK_DATABASE=true` in `NODE_ENV=production`.
  - **Distinction / Outstanding Limitations:** Local offline mode (HTTP 503) and development mock readiness (HTTP 200) verified. Real MongoDB Atlas cloud cluster provisioning is deferred to deployment phases (no Atlas cluster provisioned in Phase 1; development mock mode does NOT demonstrate real MongoDB connectivity).

- [x] **P1-FND-05 — React/Vite route/UI shell and dev proxy.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Implemented under Agent B (`P1-FE-01`), merged via PR #3 at commit `65a2782` with remediation R1.
  - **Evidence:** [`apps/web/TEST_EVIDENCE/P1-FE-01.md`](../apps/web/TEST_EVIDENCE/P1-FE-01.md) and [`docs/TEST_EVIDENCE/phase-01.md`](TEST_EVIDENCE/phase-01.md).
  - **Verification:** React 19 + Vite 8 + Tailwind CSS v4 frontend shell in `apps/web`. Responsive down to 375px mobile viewport. Accessible route scaffold with placeholders for Home (`/`), Interview (`/interview`), Dashboard (`/dashboard`), Pricing (`/pricing`), and accessible 404. Admin access strictly disabled (`aria-disabled="true"`, 404 on direct `/admin` access). Bounded API client with 5-second deadline, cancellation, and unmount cleanup. `<HealthStatus />` component rendering distinct states: Checking, Online, Offline, Ready, Not Ready (HTTP 503), Unavailable (HTTP 502/500), Timeout, and Invalid API Response. Tested in `apps/web/src/tests/` (29/29 tests pass).
  - **Limitations:** Public navigation pages display honest roadmap placeholders; no simulated sessions, mock users, or fake billing checkouts.

- [x] **P1-FND-06 — API/frontend tests, build/lint/typecheck and CI.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Merged via PR #2 (`2754ef1`), PR #3 (`65a2782`), and integration commit `1c9be95`.
  - **Evidence:** [`docs/TEST_EVIDENCE/phase-01.md`](TEST_EVIDENCE/phase-01.md) and [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
  - **Verification:** 75/75 automated tests passing across 11 test suites (11 contracts, 35 API, 29 web). Full monorepo build (`npm run build`), strict typecheck (`npm run typecheck`), linting (`npm run lint`), and audit (`npm audit`) passing with exit code 0. GitHub Actions CI workflow running on `ubuntu-latest`, Node.js 22, with `contents: read` permissions. GitHub CodeQL analysis workflows passing, with the repository's security tab independently verified with 0 open security alerts.
  - **Limitations:** End-to-end browser automation (Playwright) deferred to Phase 11; current testing combines Vitest, Supertest, React Testing Library, and live smoke testing.

- [x] **P1-FND-07 — Validated config, env/redaction, session-origin ADR.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Implemented under `P1-BE-01`, merged via PR #2 (`2754ef1`).
  - **Evidence:** [`docs/TEST_EVIDENCE/P1-BE-01.md`](TEST_EVIDENCE/P1-BE-01.md) and [`docs/ENGINEERING_RESEARCH_AND_ADRS.md`](ENGINEERING_RESEARCH_AND_ADRS.md).
  - **Verification:** Strict Zod environment schema in `apps/api/src/config/env.ts` validating required configuration and coercion, rejecting invalid values (such as malformed URLs, non-integer ports, or invalid MOCK_DATABASE representations), and enforcing production guardrails; sensitive data redaction in Pino operational logs (`apps/api/src/core/logging.ts`); Helmet CSP defaults; CORS rejection of unapproved browser origins; and alignment with established architectural research decisions (ADR-017 for modular architecture, ADR-023 for same-origin proxy, and ADR-027 for origin/session protections documented in [`docs/ENGINEERING_RESEARCH_AND_ADRS.md`](ENGINEERING_RESEARCH_AND_ADRS.md)).
  - **Limitations:** Optional provider credentials (Firebase, Groq, Cloudflare, Brevo) defined in `.env.example` as placeholders but not connected in Phase 1.

- [x] **P1-FND-08 — README, architecture docs, evidence, reviewed first commit.**
  - **Status:** Complete.
  - **PR & Merge Commit:** Executed under `P1-CLOSE-01` on branch `chore/phase-1-closure` (PR #4).
  - **Evidence:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), [`README.md`](../README.md), and [`docs/TEST_EVIDENCE/phase-01.md`](TEST_EVIDENCE/phase-01.md).
  - **Verification:** Delivered comprehensive system architecture specification in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), updated developer [`README.md`](../README.md) with accurate Node 22 setup, local startup instructions (`npm run dev:api` and `npm run dev:web`), explicit `MOCK_DATABASE=true` environment command without unapproved `.env` loading dependencies, health/readiness documentation, links to test evidence, and honest disclosures of unimplemented Phase 2–11 features.
  - **Limitations:** Production cloud deployment deferred to Phase 11.

## Phase 2 — Identity

- [x] **P2-DESIGN-01** — independently challenged `auth.v1` design / ADR-028; accepted **only upon owner-approved merge of this documentation PR**. This is design evidence, not implemented auth or tested deployment.
- [ ] **P2-SPIKE-01** — prove free Atlas transaction/index behavior, Brevo authorized sender and provider quota reset, proxy/cookie integration and Argon2 free-memory capacity before live release.

- [ ] P2-AUTH-01 Users/identities/session models and indexes.
- [ ] P2-AUTH-02 Firebase Google ID token verification + app session.
- [ ] P2-AUTH-03 Custom email/password Argon2id registration/login.
- [ ] P2-AUTH-04 OTP verify/reset/resend, email mock + Brevo HTTP integration test.
- [ ] P2-AUTH-05 Rotating opaque refresh session, revocation, CSRF, abuse limits (short-lived access JWT).
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
| 2026-11-22 | P1-FND-01 (Bootstrap) | PR #1 (commit `653f1c5`) | Monorepo scaffold & governance verified |
| 2026-11-22 | P1-BE-01 (Backend API & Readiness) | PR #2 (merge `2754ef1`, commit `2105542`) | Express API, Mongoose readiness, CI, 35 tests pass |
| 2026-11-22 | P1-FE-01 (Frontend Shell & Health UI) | PR #3 (merge `65a2782`, commit `a468fcf`) | React 19 / Vite 8 UI shell, health matrix, 29 tests pass |
| 2026-11-22 | P1-INT-01 (Full-Stack Monorepo Integration) | Commit `1c9be95`, `docs/TEST_EVIDENCE/phase-01.md` | Monorepo reconciled, 75/75 tests pass, smoke verified |
| 2026-11-22 | P1-CLOSE-01 (Phase 1 Repository Closure) | PR #4, `docs/ARCHITECTURE.md` | Documentation, architecture, and tracker closed; ready for Phase 2 |
