# Roundset — System Architecture

**Version:** 1.0 (Phase 1 Foundation)  
**Date:** 2026-11-22  
**Status:** Verified Merged Implementation (`main`)

This document describes the implemented architectural foundation of Roundset following the completion of Phase 1 (`P1-FND-01` through `P1-FND-08`). It reflects exclusively verified source code merged into the repository. Planned capabilities for Phase 2 onward are cataloged in [Unimplemented Features & Future Phases](#unimplemented-features--future-phases).

---

## 1. Monorepo & Workspace Structure

Roundset is structured as a typed TypeScript modular monolith using native npm workspaces under Node.js 22 LTS:

```text
Roundset/
├── apps/
│   ├── api/             # @roundset/api (Express 5 HTTP service)
│   └── web/             # @roundset/web (React 19 + Vite 8 + Tailwind CSS v4 SPA)
├── packages/
│   └── contracts/       # @roundset/contracts (Shared Zod runtime schemas & DTO types)
├── docs/
│   ├── ADR/             # ADR process and guidelines
│   ├── TEST_EVIDENCE/   # Automated test logs, verification reports, and integration audits
│   ├── tasks/           # Architect-authored atomic task specifications
│   ├── plan/            # Agent planning and parallel execution specifications
│   ├── ARCHITECTURE.md  # System architecture (this document)
│   └── IMPLEMENTATION_TRACKER.md # Live phase-by-phase completion tracker
└── legacy/              # Historical product decisions and Phase 0 discovery records
```

### Workspace Boundaries
- **`packages/contracts`:** Pure runtime schemas and TypeScript DTO definitions. Zero runtime dependencies other than `zod@4.6.7`. Consumed by both `apps/api` and `apps/web`.
- **`apps/api`:** Express 5 HTTP application. Exclusively handles API routing, middleware, request validation, environment configuration, database connection management, and operational logging.
- **`apps/web`:** React 19 single-page application built with Vite 8. Exclusively handles candidate-facing UI presentation, routing, client-side deadline enforcement, and accessible health monitoring.

---

## 2. Shared Contracts (`packages/contracts`)

Shared contracts eliminate drift between API and client by establishing single-source-of-truth Zod runtime validators:

- **`LivenessResponseSchema`:**
  - Structure: `{ data: { status: "ok", version: string }, meta: { requestId: UUID } }`
  - Validates process liveness responses.
- **`ReadinessResponseSchema`:**
  - Structure: `{ data: { ready: boolean }, meta: { requestId: UUID } }`
  - Validates dependency readiness responses.
- **`ApiErrorResponseSchema`:**
  - Structure: `{ error: { code: string, message: string, requestId: UUID, details?: unknown } }`
  - Validates standardized error responses across all HTTP status codes.
- **`PlanCodeSchema`:**
  - Enum validator for approved plan tiers: `'FREE'`, `'PAID_250'`, `'PAID_500'`, `'PAID_1000'`, `'VIP'`.
- **`InterviewStatusSchema`:**
  - Enum validator for interview session states: `'DRAFT'`, `'PREFLIGHT'`, `'READY'`, `'ACTIVE'`, `'RECOVERING'`, `'COMPLETED'`, `'TERMINATED_INTEGRITY'`, `'ABORTED_PREFLIGHT'`, `'ABORTED_SYSTEM'`, `'EXPIRED'`.

---

## 3. Application Boundaries & Request Flow

```
                      Browser Client (apps/web)
                                │
                        http://localhost:5173
                                │
                  Vite Dev Proxy (/api -> :8787)
                                │
                                ▼
                     Express API (apps/api)
                                │
                        http://localhost:8787
                                │
    ┌───────────────────────────┴───────────────────────────┐
    ▼                                                       ▼
Request ID Middleware (:crypto.randomUUID)            Security Middleware
- Generates unforgeable X-Request-ID                  - Helmet CSP defaults
- Sets req.id & response header                      - CORS origin check (WEB_ORIGIN)
                                                      - 64 KiB JSON body limit
                                                      - Trust proxy hops config
    ┌───────────────────────────────────────────────────────┘
    ▼
Router (/api/v1)
    ├── GET /health/live  ──> Returns HTTP 200 (Process Liveness)
    └── GET /health/ready ──> Injects ReadinessProvider
                               ├── MOCK_DATABASE=true ──> MockReadinessProvider (200 OK)
                               └── Real Mode          ──> MongoManager.isReady()
                                                            ├── Connected    ──> 200 OK
                                                            └── Disconnected ──> 503 Unavailable
    │
    ▼
Centralized Error Handler
- Standardized error codes (400, 404, 413, 403, 500)
- Masked 500 errors (no internal stack traces or paths exposed to clients)
- Safe structured Pino operational logs
```

### Health & Readiness Execution Flow
1. **Liveness (`GET /api/v1/health/live`):**
   - Pure process check. Returns HTTP 200 immediately with minimal version metadata.
   - Decoupled from database connectivity: remains healthy even when MongoDB is offline or disconnected.
2. **Readiness (`GET /api/v1/health/ready`):**
   - Dependency check. Injects `ReadinessProvider`.
   - Returns HTTP 200 with `{ data: { ready: true } }` when dependencies are connected.
   - Returns HTTP 503 with `{ data: { ready: false } }` when MongoDB is disconnected or unconfigured.
3. **Frontend Health Component (`apps/web/src/components/HealthStatus.tsx`):**
   - Queries `/api/v1/health/live` and `/api/v1/health/ready` through `src/lib/api.ts`.
   - Enforces a 5-second end-to-end deadline via `AbortController` covering both network transit and body parsing.
   - Implements a strict status/body truth matrix:
     - `HTTP 200` + `ready: true` → **Ready** (Green)
     - `HTTP 503` + `ready: false` → **Not Ready** (Amber: dependencies initializing)
     - `HTTP 200` + `ready: false` OR `HTTP 503` + `ready: true` → **Invalid Response**
     - `HTTP 502 / 500 / 404` → **Unavailable** (Amber: upstream proxy/server failure)
     - Network failure / connection refused → **Offline** (Red)

---

## 4. Database Integration & Lifecycle Management

Database interactions are managed via `MongoManager` in `apps/api/src/integrations/mongodb.ts`:

- **Single Connection Manager:** Wraps a single `mongoose.connection` instance.
- **Bounded Timeouts:** Enforces 5-second connection and server-selection limits:
  ```ts
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000
  ```
- **Asynchronous Non-Blocking Startup:** In `apps/api/src/server.ts`, the HTTP listener binds and begins serving requests before the MongoDB connection resolves. Liveness is available instantly; readiness transitions to 200 once Mongoose emits `connected`.
- **Listener Isolation & Cleanup:** `MongoManager` attaches named handlers (`onDisconnectedHandler`, `onReconnectedHandler`, `onErrorHandler`). On disconnect or failed HTTP startup (`EADDRINUSE`), `removeConnectionListeners()` strips only manager-owned listeners from `mongoose.connection`, leaving unrelated external listeners intact.
- **Sanitized Operational Logging:** Connection logs emit strictly fixed diagnostic categories (`DATABASE_LIFECYCLE`, `DATABASE_CONNECTION_TIMEOUT`, `DATABASE_RUNTIME_ERROR`) and safe connection state (`connecting`, `connected`, `disconnected`, `reconnected`, `failed`, `error`). Database URIs, passwords, query strings, and raw driver exceptions are never serialized into logs.
- **Development Mock Mode:**
  - Invoked via `MOCK_DATABASE=true npm run dev:api`.
  - Enables `MockReadinessProvider(true)` for local UI testing without a running MongoDB daemon.
  - Logs a visible operational warning: `[DEVELOPMENT MOCK] MOCK_DATABASE=true is active. Mock readiness enabled.`
  - **Production Guardrail:** Zod environment validation strictly rejects `MOCK_DATABASE=true` when `NODE_ENV=production`.
  - *Note:* Mock readiness serves exclusively for UI contract testing; it does not demonstrate real MongoDB connectivity.

---

## 5. Security & Operational Boundaries

1. **Unforgeable Request IDs:**
   - Client-supplied `X-Request-ID` headers are discarded.
   - Every request is tagged with a fresh `crypto.randomUUID()` generated server-side.
   - Embedded in `meta.requestId` and error payloads for end-to-end tracing.
2. **Origin Validation & CORS:**
   - Configured via `config.WEB_ORIGIN` (defaults to `http://localhost:5173`).
   - Browser requests bearing an unapproved `Origin` header are rejected with HTTP 403 `FORBIDDEN`.
   - CLI tools, curl, and server monitors omitting `Origin` headers are permitted for health checks.
3. **HTTP Security Headers:**
   - Helmet sets strict defaults (Content-Security-Policy, Frameguard, Hide Powered-By).
4. **Payload Limiting:**
   - Express JSON body parser strictly capped at 64 KiB.
   - Oversized payloads trigger standardized HTTP 413 `PAYLOAD_TOO_LARGE`.
5. **Masked Error Handling:**
   - Standardized error codes: 400 (`INVALID_INPUT`), 404 (`NOT_FOUND`), 413 (`PAYLOAD_TOO_LARGE`), 403 (`FORBIDDEN`), and 500 (`INTERNAL_ERROR`).
   - 500 error responses emit a sanitized generic message: `"An unexpected internal server error occurred"`. Raw exception objects, messages, stack traces, and internal paths are never exposed to clients.
6. **Structured Log Redaction:**
   - Pino operational logger redacts sensitive HTTP headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`), passwords, tokens, and URIs.
   - Lifecycle and startup logs use static diagnostic strings without reflecting environment variables into log output.
7. **Standalone Process Direct-Entry Detection:**
   - `isDirectEntry(import.meta.url)` compares `fs.realpathSync(process.argv[1])` to `fs.realpathSync(fileURLToPath(metaUrl))`.
   - Importing `apps/api/src/index.ts` or `server.ts` causes zero port binding, zero database connections, and zero signal handler installations.
   - Standalone execution binds signal handlers for `SIGINT` and `SIGTERM` with an unref'd 10-second graceful shutdown timer.

---

## 6. Development & Verification Architecture

### Automated Test Architecture
- **Framework:** Vitest 5.1.1 across all workspaces.
- **API Testing:** Supertest against `createApp` factory (binds no ephemeral ports during testing).
- **Web Testing:** `@testing-library/react` and `jsdom` testing components, route rendering, and deadline timeouts.
- **Test Suites (75 tests total, 100% passing):**
  - `packages/contracts/tests/contracts.test.ts` (11 tests)
  - `apps/api/tests/health.test.ts` (3 tests)
  - `apps/api/tests/security.test.ts` (6 tests)
  - `apps/api/tests/errors.test.ts` (5 tests)
  - `apps/api/tests/config.test.ts` (7 tests)
  - `apps/api/tests/contracts-integration.test.ts` (3 tests)
  - `apps/api/tests/mongodb-logging.test.ts` (4 tests)
  - `apps/api/tests/startup.test.ts` (7 tests)
  - `apps/web/src/tests/api.test.ts` (10 tests)
  - `apps/web/src/tests/HealthStatus.test.tsx` (12 tests)
  - `apps/web/src/tests/App.test.tsx` (7 tests)

### Continuous Integration (GitHub Actions)
- Defined in `.github/workflows/ci.yml`.
- Runs on `ubuntu-latest`, Node.js 22 LTS, `contents: read`.
- Executes sequentially: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm audit --omit=dev`.
- GitHub CodeQL analysis runs on pull requests and pushes to `main`, reporting 0 alerts.

---

## 7. Unimplemented Features & Future Phases

In strict adherence to the project roadmap, the following features are **not implemented** in Phase 1:

| Phase | Planned Domain | Current Implementation Boundary |
|---|---|---|
| **Phase 2** | Identity & Authentication | No user models, sessions, Firebase Google token verification, Argon2id passwords, or JWT refresh rotation exist. |
| **Phase 3 & 10** | Entitlements, Quotas & Billing | No quota ledger, credit reservations, or payment sandbox exist. Pricing UI (`/pricing`) is an informative placeholder. |
| **Phase 4** | AI Inference & Interview Controller | No LLM provider adapters (Groq/Cloudflare), state machines, prompt rubrics, or dynamic questions exist. Interview UI (`/interview`) is a roadmap placeholder. |
| **Phase 5** | Voice & Audio Pipeline | Audio models (Kokoro WebGPU TTS, Silero VAD, Web Speech STT) remain archived in external feasibility prototypes and are not connected to Roundset source code. |
| **Phase 6** | Integrity & Proctoring | No MediaPipe face tracking, fullscreen locks, or clipboard monitoring exist. |
| **Phase 7** | Evaluation & Scoring | No automated scoring rubrics, candidate performance analytics, or PDF generators exist. |
| **Phase 8** | Live Coding & Personalization | No Monaco code editor or resume parsing exists. |
| **Phase 10** | Admin & VIP Management | The admin route is disabled (`aria-disabled="true"`, returns 404) until real backend RBAC is built. |
| **Phase 11** | Cloud Deployment | Production MongoDB Atlas clusters and hosting infrastructure are deferred. |

---

## 8. Canonical References & ADRs

- **Master Engineering Roadmap:** [`AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`](../AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md)
- **Phase 1 Coding Brief:** [`docs/PHASE_01_CODING_BRIEF.md`](PHASE_01_CODING_BRIEF.md)
- **Data & API Contracts:** [`docs/API_AND_DATA_CONTRACTS.md`](API_AND_DATA_CONTRACTS.md)
- **Engineering Research & Architectural Decisions:** [`docs/ENGINEERING_RESEARCH_AND_ADRS.md`](ENGINEERING_RESEARCH_AND_ADRS.md)
  - **ADR-017:** Modular Express/TypeScript Monolith, React/TypeScript Vite, MongoDB
  - **ADR-018:** Firebase Auth for Google only + custom email/password auth and app sessions
  - **ADR-019:** Groq Qwen 3.8 27B primary; Cloudflare Qwen 3.8 27B fallback
  - **ADR-020:** Web Speech API + Silero VAD + Kokoro browser voice pipeline
  - **ADR-021:** Backend-authoritative state machine + MongoDB durable checkpoints
  - **ADR-022:** Atomic per-user-period usage ledger with idempotency
  - **ADR-023:** Same-origin API proxy strategy (Cloudflare Pages → Render Free)
  - **ADR-024:** Sandbox billing only, provider-neutral adapter
  - **ADR-025:** Strict premium data separation at API resource level
  - **ADR-026:** No heavy real-time streaming services or Redis requirement for v1
  - **ADR-027:** Short-term app JWT + rotating HttpOnly refresh cookie, CSRF/origin protections
- **Governance Agreement:** [`AGENTS.md`](../AGENTS.md)
