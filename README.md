# Roundset

> High-integrity AI technical interviewer platform designed for rigorous, automated candidate preparation and assessment.

[![CI](https://github.com/silent-knight19/Roundset/actions/workflows/ci.yml/badge.svg)](https://github.com/silent-knight19/Roundset/actions/workflows/ci.yml)
[![CodeQL](https://github.com/silent-knight19/Roundset/actions/workflows/codeql.yml/badge.svg)](https://github.com/silent-knight19/Roundset/actions/workflows/codeql.yml)

---

## Current Status: Phase 1 Complete & Verified

Phase 1 (Monorepo Foundation, Express API, React/Vite UI Shell, Shared Zod Contracts, Mongoose Readiness, and CI) is **fully implemented, tested, reviewed, and merged into `main`**.

- **Backend PR:** [PR #2](https://github.com/silent-knight19/Roundset/pull/2) (merged at `2754ef1`)
- **Frontend PR:** [PR #3](https://github.com/silent-knight19/Roundset/pull/3) (merged at `65a2782`)
- **Integration & Lockfile Reconciliation:** Merged at `1c9be95`
- **Total Test Coverage:** 75/75 tests passing across 11 test suites
- **Security & CodeQL:** CodeQL automated scanning workflows completed successfully on GitHub Actions, and the repository's Code Scanning tab independently reports **0 open security alerts**.

Subsequent phases (Phase 2 Identity through Phase 11 Deployment) are scheduled and pending architectural kickoff. See [Unimplemented Features & Next Phases](#unimplemented-features--next-phases).

---

## Project Architecture & Monorepo Structure

Roundset is built as a typed TypeScript modular monolith organized as native npm workspaces under Node.js 22 LTS:

```text
Roundset/
├── apps/
│   ├── api/             # @roundset/api (Express 5 TypeScript HTTP service)
│   └── web/             # @roundset/web (React 19 + Vite 8 + Tailwind CSS v4 frontend)
├── packages/
│   └── contracts/       # @roundset/contracts (Shared Zod runtime schemas & DTO types)
├── docs/
│   ├── ADR/             # ADR process and guidelines
│   ├── TEST_EVIDENCE/   # Executed test logs and verification records
│   ├── tasks/           # Architect-authored atomic task specifications
│   ├── plan/            # Agent planning and execution roadmaps
│   ├── ARCHITECTURE.md  # System architecture specification
│   └── IMPLEMENTATION_TRACKER.md # Live phase-by-phase completion tracker
└── legacy/              # Historical research and Phase 0 discovery records
```

> **Note on Voice Prototype Archives:** The feasibility voice prototype (Kokoro WebGPU TTS, Silero VAD, Web Speech STT) and historical Groq Qwen inference metrics from Phase 0 are preserved in external project feasibility archives (`ai-interviewer-conversation-poc.zip`). They are kept separate from the application codebase and are not committed source assets.

---

## Prerequisites

- **Node.js**: `v22.x` LTS (enforced via `.nvmrc`)
- **npm**: `10.x` or higher (native npm workspaces only; pnpm, Yarn, Turborepo, and Nx are prohibited)
- **Git**: Isolated atomic task branching per [`AGENTS.md`](AGENTS.md)

---

## Getting Started & Local Development

### 1. Installation

Install all workspace dependencies deterministically from the root lockfile:

```bash
npm ci
```

### 2. Running Services Locally

Roundset services can be started independently or concurrently:

#### Option A: Running the Backend API (Express)
```bash
npm run dev:api
```
- Starts the Express HTTP service at **`http://localhost:8787`** using `tsx watch` for hot-reload.
- Decoupled from listening socket in unit tests (`createApp` factory).

#### Option B: Running the Frontend (React / Vite)
```bash
npm run dev:web
```
- Starts the Vite development server at **`http://localhost:5173`**.
- Configured with a built-in development proxy forwarding `/api` requests to `http://127.0.0.1:8787`.

#### Option C: Full-Stack Development
Run `npm run dev:api` and `npm run dev:web` in separate terminal windows. Opening `http://localhost:5173` in your browser will display the live candidate portal with real-time backend health monitoring.

---

## Health & Readiness Architecture

Roundset implements strict, independent HTTP liveness and dependency readiness endpoints:

| Endpoint | Standard HTTP Status | Payload Schema | Description |
|---|:---:|---|---|
| `GET /api/v1/health/live` | `200 OK` | `LivenessResponseSchema` | Process liveness. Returns `{ data: { status: "ok", version: "0.1.0" }, meta: { requestId } }`. Always returns 200 even when dependencies are offline. |
| `GET /api/v1/health/ready` | `200 OK` / `503 Unavailable` | `ReadinessResponseSchema` | Dependency readiness. Returns `{ data: { ready: boolean }, meta: { requestId } }`. Returns `503` when MongoDB is unconfigured or disconnected. |

### Development-Only Mock Mode

When developing locally without a running MongoDB instance, start the API service with the `MOCK_DATABASE` environment variable set:

```bash
MOCK_DATABASE=true npm run dev:api
```

- The API will log a visible warning banner: `[DEVELOPMENT MOCK] MOCK_DATABASE=true is active. Mock readiness enabled.` and report `ready: true` on `/api/v1/health/ready`.
- **Production Guardrail:** `MOCK_DATABASE=true` is strictly rejected by Zod environment schema validation when `NODE_ENV=production`.
- **Note on Connectivity:** Development mock readiness serves exclusively for frontend contract testing. It does **not** demonstrate real MongoDB connectivity.
- **Environment Invariant:** The application loads configuration directly from `process.env`. Do not rely on unapproved environment-loading packages or uncommitted `.env` files.

---

## Available Root Commands

All commands are executed from the monorepo root:

| Command | Purpose |
|---|---|
| `npm run dev:api` | Start API service in watch mode (`apps/api`) |
| `npm run dev:web` | Start Vite development server (`apps/web`) |
| `npm test` | Run full Vitest suite (75 tests across contracts, api, and web) |
| `npm run typecheck` | Strict TypeScript checking across all workspaces |
| `npm run lint` | Run ESLint across all workspaces |
| `npm run build` | Build contracts, API, and production Vite frontend bundle |
| `npm audit` | Check dependencies for known security vulnerabilities (0 found) |
| `npm audit --omit=dev` | Production dependency vulnerability audit (0 found) |

---

## Canonical Architecture Documents & Evidence

- **System Architecture:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Master Roadmap:** [`AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`](AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md)
- **Phase 1 Coding Brief:** [`docs/PHASE_01_CODING_BRIEF.md`](docs/PHASE_01_CODING_BRIEF.md)
- **API & Data Contracts:** [`docs/API_AND_DATA_CONTRACTS.md`](docs/API_AND_DATA_CONTRACTS.md)
- **Engineering Research & ADRs:** [`docs/ENGINEERING_RESEARCH_AND_ADRS.md`](docs/ENGINEERING_RESEARCH_AND_ADRS.md)
- **Implementation Tracker:** [`docs/IMPLEMENTATION_TRACKER.md`](docs/IMPLEMENTATION_TRACKER.md)
- **Governance Agreement:** [`AGENTS.md`](AGENTS.md)

### Phase 1 Verification Evidence:
- **Full-Stack Integration Evidence:** [`docs/TEST_EVIDENCE/phase-01.md`](docs/TEST_EVIDENCE/phase-01.md) *(Note: Visual smoke-test screenshots referenced in reports were captured locally during browser verification and are not committed repository assets)*
- **Backend Test Evidence:** [`docs/TEST_EVIDENCE/P1-BE-01.md`](docs/TEST_EVIDENCE/P1-BE-01.md)
- **Frontend Test Evidence:** [`apps/web/TEST_EVIDENCE/P1-FE-01.md`](apps/web/TEST_EVIDENCE/P1-FE-01.md)
- **Bootstrap Evidence:** [`docs/TEST_EVIDENCE/P1-FND-01.md`](docs/TEST_EVIDENCE/P1-FND-01.md)

---

## Unimplemented Features & Next Phases

In accordance with [`AGENTS.md`](AGENTS.md), Phase 1 established foundational plumbing only. The following capabilities are **not yet implemented** and remain scheduled for upcoming phases:

- **Phase 2 — Identity & Authentication:** No user accounts, Google Sign-In token verification, Argon2id password registration, email OTP, or session JWT refresh rotation exist yet.
- **Phase 3 & 10 — Entitlements, Quotas & Billing:** No payment gateways, credit reservation ledgers, or checkout flows exist. The `/pricing` page renders an informative placeholder.
- **Phase 4 — AI & Interview Orchestration:** No LLM providers (Groq Qwen / Cloudflare AI), interview state machine, prompts, or dynamic question generation exist. The `/interview` route displays a roadmap placeholder.
- **Phase 5 — Voice & Audio:** Voice models (Kokoro WebGPU TTS, Silero VAD, Web Speech STT) remain archived in external feasibility prototypes and are not connected to the application shell.
- **Phase 6 — Integrity & Proctoring:** MediaPipe face detection, fullscreen monitoring, and clipboard violation reducers are not mounted.
- **Phase 7 — Evaluation & Scoring:** Automated rubrics, candidate scoring algorithms, and PDF report generators are not implemented.
- **Phase 8 — Coding & Personalization:** Monaco coding editor and resume parsing are not implemented.
- **Phase 10 — Admin Console:** The `/admin` navigation placeholder is disabled (`aria-disabled="true"`) and direct access returns 404 until real backend RBAC is introduced.
- **Phase 11 — Production Deployment:** Cloud MongoDB Atlas clusters and Render/Cloudflare deployment topologies are deferred.

---

## Engineering Governance

All development follows the strict operating agreement in [`AGENTS.md`](AGENTS.md):
- **Principal Software Architect:** ChatGPT acts as architect, task spec owner, and independent code reviewer.
- **Coding Agents:** Act as implementation executors on isolated atomic task branches.
- **Merge Authority:** Project owner retains exclusive merge authority.
- **Cost Invariant:** Strict ₹0 operating cost policy; no paid cloud resources or unapproved external dependencies.
