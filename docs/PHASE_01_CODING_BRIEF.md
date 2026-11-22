# Phase 1 — Coding Kickoff: Repository, API, Frontend, Database and Engineering Guardrails

**Status:** IMPLEMENTED & ACCEPTED (Phase 1 complete). Merged in PR #2 and PR #3; verified in docs/TEST_EVIDENCE/phase-01.md.

## 0. Objective / working agreement

Create the first production-oriented **TypeScript MERN monorepo foundation**, deployable without paid dependencies. **Do not** implement complete auth/interviews/AI in Phase 1. Instead, create clean module seams so Phase 2 onward can be implemented without refactoring the whole project. Retain existing working voice POC as archival code/reference, not as the application backend.

**Reference files to read before coding:**
1. `../AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`
2. `ENGINEERING_RESEARCH_AND_ADRS.md`
3. `API_AND_DATA_CONTRACTS.md`
4. `../legacy/01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`
5. `../reference-prototypes/ai-interviewer-conversation-poc-metrics.zip` for voice/source compatibility.

## 1. Exact implementation sequence

### P1-FND-01 — Initialize repo / toolchain

**Files:** root `package.json`, `package-lock.json`, `.gitignore`, `.editorconfig`, `.nvmrc` or `.node-version`, `tsconfig.base.json`, `eslint.config.js`, root `.env.example`, `README.md`.

- Node 22 LTS+; npm workspaces: `apps/web`, `apps/api`, `packages/contracts`.
- TypeScript strict, noUncheckedIndexedAccess, ESLint, formatter if useful, exact lockfile. Scripts: `dev`, `dev:web`, `dev:api`, `build`, `typecheck`, `lint`, `test`.
- Ensure `.env`, `.env.local`, secrets, credentials, debug logs, metrics and database dumps ignored. No live keys copied from old POC.
- Include `docs/ADR/` and `docs/TEST_EVIDENCE/` empty placeholders with README to define audit process.

**Accept:** clean `npm install`; `npm run typecheck` and `npm run lint` exit 0 on scaffold.

### P1-FND-02 — Create Express TypeScript HTTP shell

**Files:** `apps/api/src/server.ts`, `app.ts`, `config/env.ts`, `core/errors.ts`, `core/request-id.ts`, `core/logging.ts`, `core/security.ts`, `routes/index.ts`.

- Express app factory separate from listener, so Supertest tests do not bind a port.
- Add `GET /api/v1/health/live` that answers even with Mongo offline and returns minimal build/version info; `GET /api/v1/health/ready` checks required dependencies using dependency injection.
- JSON size limits, Helmet with CSP strategy documented for wasm/WebGPU and media, trust proxy controlled, Origin/CORS rules, request ID middleware, centralized error handler and not-found handler.
- **Never** expose unprotected `/api/metrics`, old CSV endpoint or debug secrets publicly. Provider keys remain backend-only.

**Accept:** `GET /api/v1/health/live → 200`, invalid route → 404 standardized error with request ID, overlarge JSON → 413, malformed JSON → 400, injected service fault → 5xx sanitized. All covered by tests.

### P1-FND-03 — Shared contract package

**Files:** `packages/contracts/src/common.ts`, `health.ts`, `errors.ts`, `index.ts`, `package.json`, `tsconfig.json`.

- Zod `HealthLiveResponse`, `HealthReadyResponse`, `ApiError`, `PlanCode` and `InterviewStatus` enumerations used on server and frontend.
- Keep docs aligned with `API_AND_DATA_CONTRACTS.md`. No `any` and no unvalidated public payload parsing.
- Add TypeScript exports so web/API share the same types and avoid duplicate DTO definitions.

**Accept:** typecheck fails for a deliberate invalid response fixture; valid fixtures pass.

### P1-FND-04 — Database connection / readiness

**Files:** `apps/api/src/integrations/mongodb.ts`, `config/env.ts`, `core/readiness.ts`.

- MongoDB via Mongoose and one connection manager with bounded server-selection timeout; no open connections at import time in unit tests.
- Validate `MONGODB_URI` only when Atlas mode enabled, allow `MOCK_DATABASE=true` for isolated local tests **with clear visible development-only labeling**.
- `ready` false while DB unhealthy; `live` still works. Add start/shutdown logic, log connection state only, never URI/password.
- Define repositories module boundary but **do not** yet create 17 production collections. Those are later phase-specific migrations.

**Accept:** mock database readiness tests pass; invalid secret config refused in `NODE_ENV=production`; no reliance on Render local disk.

### P1-FND-05 — React/Vite UI shell

**Files:** `apps/web/package.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/lib/api.ts`, `src/app/router.tsx`.

- Tailwind CSS + shadcn/ui installed according to compatible versions, minimal accessible layout with navigation placeholders: Home, Interview, Dashboard, Pricing, Admin (Admin route should be unavailable until real backend RBAC; **don't** make a fake secured admin route).
- Home displays **real fetched API liveness status** and labels database readiness independently. Use `AbortController`, timeout and accessible loading/error states.
- In dev, Vite proxy `/api` to local Express; `fetch('/api/v1/health/live')` rather than hard-coded production origin.
- No API keys in web `VITE_*`; no real user content or pretend completed functionality.

**Accept:** browser displays response from API; if backend stopped, shows controlled offline state instead of crashing. Typecheck/build passes.

### P1-FND-06 — Testing and CI

**Files:** `apps/api/tests/health.test.ts`, `errors.test.ts`, `config.test.ts`, `apps/web/src/App.test.tsx` if test setup included, `.github/workflows/ci.yml`.

- Vitest + Supertest API tests; no external keys/internet needed; mock DB. Minimal frontend smoke test (Testing Library or Playwright later), no snapshot-only false confidence.
- CI `npm ci`, lint, typecheck, test, build; secret scanning/no credential presence check as feasible with free CI.
- Tests must be reproducible. Manual screenshots or behavior are separately labeled.

**Accept:** test outputs/logs committed under `docs/TEST_EVIDENCE/phase-01.md` with commands, versions, output, failures and known limitations.

### P1-FND-07 — Security and config scaffolding

**Files:** `apps/api/src/config/env.ts`, `core/security.ts`, `.env.example`, `docs/ADR/001-session-origin.md`.

- Provide placeholder env keys: `NODE_ENV`, `PORT`, `WEB_ORIGIN`, `MONGODB_URI`, `MOCK_DATABASE`, `FIREBASE_PROJECT_ID`, `GROQ_API_KEY`, `GROQ_MODEL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`, `EMAIL_PROVIDER`, `BREVO_API_KEY`, `SMS_PROVIDER`, `BILLING_MODE`, `ADMIN_BOOTSTRAP_EMAIL`.
- **No need to populate or use** AI, payment, email, Firebase secrets yet. Missing optional keys must not cause a crash. In production missing critical DB/session secrets must cause a clear startup error; unknown env values rejected.
- Cookie/origin ADR documents eventual same-origin Pages Function proxy and fallback Render single origin, warns about direct cross-site refresh cookies. Do NOT implement untested pseudo-secure auth.
- Add request sanitization and disable exposing full response body in logs.

**Accept:** `npm test` verifies no secrets in config-error output; `MOCK_DATABASE` refused for production; security headers present as appropriate.

### P1-FND-08 — First integration checkpoint / developer docs

**Files:** `README.md`, `docs/ARCHITECTURE.md`, `docs/TEST_EVIDENCE/phase-01.md`.

- Document local start, folder organization, health endpoints, env/secret rules, where the voice POC will be migrated, current limitations and exact next phase.
- Run all root commands and report actual exit codes.
- Keep all UI clearly marked as scaffold: no invented account, invoice or interview history.
- Commit with meaningful commit message `feat(foundation): scaffold typed MERN monorepo` only after evidence gates pass.

**Accept:** fresh Mac user can clone, `npm ci`, set development env, start both servers and see UI/health without paid accounts. Tests pass or blockers are precisely reported, never silently marked complete.

## 2. Proposed packages (choose compatible latest pinned versions during implementation)

| Module | Candidate packages | Why |
|---|---|---|
| HTTP | `express`, `helmet`, `cors`, `express-rate-limit` | Standard secure Node APIs |
| Validation | `zod` | Shared contract runtime validation |
| Database | `mongoose` | MongoDB schema/index and connection support |
| Logging | `pino`, `pino-http` | Structured logs with sensitive field redaction |
| Dev/build | `typescript`, `tsx`, `vite`, `@vitejs/plugin-react` | Strict TS backend/React frontend |
| UI | `react`, `react-dom`, `react-router-dom`, `tailwindcss`, `shadcn` | Accessible modern UI without building a design system now |
| Test | `vitest`, `supertest`, `@types/supertest`, Testing Library if needed | Integration tests independent of paid APIs |

Avoid a Redis dependency, task queue, WebSocket server, worker scheduler, microservices, remote code execution, payment provider SDK and paid observability **in Phase 1**. Add each only with a demonstrated product need and a feasible free deployment path.

## 3. Expected minimal local endpoints

```text
GET http://127.0.0.1:8787/api/v1/health/live
  -> HTTP 200 {data:{status:"ok",version:"0.1.0"},meta:{requestId:"..."}}

GET http://127.0.0.1:8787/api/v1/health/ready
  -> HTTP 200 {data:{ready:true},meta:{requestId:"..."}}
  OR HTTP 503 {data:{ready:false},meta:{requestId:"..."}}
  (actual DB status determines which; mocked DB is dev/test only)

GET http://127.0.0.1:8787/api/v1/nonexistent
  -> HTTP 404 {error:{code:"NOT_FOUND",message:"Not found",requestId:"..."}}
```

No hard-coded account list, fake auth guard or fake data in endpoints. Show placeholder navigation without granting access to future admin screens.

## 4. Automated test checklist

| Test ID | Test | Expected |
|---|---|---|
| P1-T01 | Health live works when DB unready | 200 |
| P1-T02 | Ready reports DB down, no secret leakage | 503, sanitized |
| P1-T03 | Every response includes request ID | Nonblank ID |
| P1-T04 | Unknown API route | JSON 404 |
| P1-T05 | Oversized/malformed JSON | 413/400 |
| P1-T06 | Simulated handler exception | 5xx, no stack trace |
| P1-T07 | Cross-origin forbidden request | Proper rejection where policy applies |
| P1-T08 | Shared Zod DTO rejects malformed fixtures | Fail validation |
| P1-T09 | UI renders backend offline state | Non-crashing accessible message |
| P1-T10 | Production config with MOCK_DATABASE=true | Rejected |
| P1-T11 | Secrets not logged | Sanitized logs |
| P1-T12 | `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` | Exit 0 |

No need to fake integration tests with live Firebase/Groq during Phase 1. Auth and real provider test suites belong to their phases.

## 5. Copy-ready coding-agent assignment

> **ROLE:** Senior full-stack TypeScript engineer implementing Phase 1 of an AI Interviewer. Treat the attached roadmap, architecture research, API contracts and canonical requirements as authoritative. Avoid new product decisions.
>
> **TASK:** Complete P1-FND-01 through P1-FND-08 from `docs/PHASE_01_CODING_BRIEF.md`. Create a fresh `ai-interviewer` repository using npm workspaces, React/Vite/TypeScript web app, Express/TypeScript API, shared Zod contract package, Mongoose readiness adapter, security middleware, proper request IDs/errors, environment validation and no-key mock mode. Write unit/integration tests and developer documentation. **Do not build authentication, billing, AI inference, proctoring or premium screens yet** beyond safe folder/module seams.
>
> **NON-NEGOTIABLE:** ₹0 services except optional future SMS OTP, never expose API keys, do not remove Firebase Google Sign-In from future architecture, do not send private candidate data to AI, do not claim simulated tests prove deployed success, do not copy the existing POC's unauthenticated metrics endpoint. Preserve the old POC under `prototypes/` as reference. Keep cookie/origin deployment risks documented.
>
> **EXECUTE:** Show a file tree and implementation summary; run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; supply actual exit codes, representative test evidence and any environment blocker. If npm install cannot run, explicitly say tests are not verified and stop short of claiming completion. Update `docs/TEST_EVIDENCE/phase-01.md` and list all changes.
>
> **ACCEPTANCE:** All 12 checks in the Phase 1 table pass, React calls real Express `/health/live`, readiness accurately reflects DB, no secrets in client/logs, no mock DB in production. Don't proceed to Phase 2 until review.

## 6. Review handoff template

```text
Phase: P1 — Foundation
Commit SHA / branch:
Files created/modified:
Design tradeoffs/ADRs:
Commands run + exit codes:
Unit/integration test results:
Manual browser evidence:
Security/secrets checklist:
Blocked/unverified:
Next recommended task:
```

**Next phase when accepted:** P2-AUTH-01 User/identity schemas, followed by secure Firebase Google token exchange and custom email/password + OTP. The implementation pack's master roadmap remains the source of broader product scope.
