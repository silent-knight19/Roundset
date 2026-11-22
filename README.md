# Roundset

> High-integrity AI technical interviewer platform designed for rigorous, automated candidate preparation and assessment.

## Project Architecture & Monorepo Structure

Roundset is built as a typed TypeScript modular monolith organized as native npm workspaces under Node.js 22 LTS:

```text
Roundset/
├── apps/
│   ├── api/             # @roundset/api (Express TypeScript HTTP service)
│   └── web/             # @roundset/web (React/Vite TypeScript frontend)
├── packages/
│   └── contracts/       # @roundset/contracts (Shared Zod runtime schemas & DTO types)
├── docs/
│   ├── ADR/             # Approved Architecture Decision Records
│   ├── TEST_EVIDENCE/   # Executed test logs and verification records
│   ├── tasks/           # Architect-authored atomic task specifications
│   └── plan/            # Agent planning and parallel execution roadmaps
├── legacy/              # Historical research and Phase 0 discovery records
└── reference-prototypes/# Validated voice/audio prototypes and baseline metrics
```

## Prerequisites

- **Node.js**: `22.x` LTS (enforced via `.nvmrc`)
- **Package Manager**: `npm` (native workspaces only; pnpm, Yarn, Turborepo, and Nx are prohibited)
- **Git**: Branching model follows isolated atomic task branches

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Verify installation:**
   ```bash
   npm ci
   ```

3. **Available Root Scripts:**
   - `npm run lint` — Lint all packages and applications with ESLint
   - `npm run typecheck` — Strict TypeScript checking across all workspaces
   - `npm test` — Run unit and contract smoke tests via Vitest
   - `npm run build` — Compile TypeScript across all workspaces
   - `npm run dev:api` — Start API development server (pending Task P1-FND-02)
   - `npm run dev:web` — Start Web development server (pending Task P1-FND-05)
   - `npm run dev` — Default development command (points to API)

> **Note on `dev` scripts:** The full Express HTTP shell and React/Vite UI shell are scheduled for implementation in upcoming atomic tasks (`P1-FND-02` and `P1-FND-05`). Running `dev` commands on the bootstrap scaffold will informatively report that application servers are pending authorization.

## Engineering Governance & Operating Rules

All contributors and coding implementation agents must strictly adhere to the operating rules documented in [`AGENTS.md`](file:///Users/silentknight/Roundset/AGENTS.md):

- **Architect Role:** ChatGPT acts as Principal Software Architect and independent reviewer.
- **Merge Authority:** Project owner retains exclusive merge authority. Implementation completed does not equal accepted.
- **Parallel Worktree Model:** Backend (`P1-BE-01`) and Frontend (`P1-FE-01`) agents work on isolated task branches/worktrees once authorized.
- **Commercial Invariant:** Strict ₹0 operating cost policy; no paid cloud resources or unapproved external dependencies.
