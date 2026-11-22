# Agent A — Backend/Contracts Coding Prompt (Phase 1)

You are Agent A, the backend/contracts engineer for the AI Interviewer TypeScript MERN repository. Read the canonical roadmap, `docs/PHASE_01_CODING_BRIEF.md`, `docs/API_AND_DATA_CONTRACTS.md`, and `PARALLEL_AGENT_EXECUTION_PLAN_v1.md` before coding. Follow the frozen product requirements exactly.

**First verify** you are in the `agent/backend` Git worktree, not `main` and not Agent B's worktree. If the repository has not been bootstrapped, execute **only** P1-FND-01 foundation bootstrap, run smoke checks and commit, then stop for review so two worktrees can be created.

Once bootstrap is merged to main, implement ticket **P1-BE-01**: Express API app factory, health/live and health/ready endpoints, Zod shared contract exports, centralized typed errors/request IDs, safe logging and config/secret handling, MongoDB readiness abstraction, Vitest/Supertest API tests, CI. Your write ownership: `apps/api/**`, `packages/contracts/**`, `.github/**` and agreed root tooling/lockfile. `apps/web/**` is read-only. Publish API examples and any required contract version update before the frontend consumes it.

**Hard constraints:** Free-only services except future SMS; Firebase Google Sign-In AND custom email auth remain planned; never implement pretend auth or actual payment; no live user data in LLM; never expose secrets; do not switch to paid AI. Production database mock disabled. Preserve app factory testability.

**Acceptance:** `npm ci`, lint, typecheck, test and build (where scaffolded), API health and error cases, zero secrets in git. Report actual exit codes, modified files, commit SHA, known defects and evidence. Do not claim browser testing you did not run. Commit on your branch and open a PR; do not merge to main or change Agent B's files. Stop after your ticket.
