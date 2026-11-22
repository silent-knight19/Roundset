# AI Interviewer — Two-Agent Parallel Implementation Plan

**Version:** 1.0 | **Date:** 2026-11-22 | **Status:** READY TO START, not implemented

## 0. Scope, precedence and prerequisite documents

This supplements (does not replace) the existing **11-phase roadmap** and its eight-task Phase 1 brief:
- `AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`
- `docs/PHASE_01_CODING_BRIEF.md`
- `docs/API_AND_DATA_CONTRACTS.md`
- `docs/ENGINEERING_RESEARCH_AND_ADRS.md`
- `legacy/01_PRODUCT_DECISIONS_AND_REQUIREMENTS.md`

In case of disagreement, newer explicit user decisions and the canonical product rules win. Do not start subsequent phases merely because an agent says it has finished; apply the integration gates below.

**Project constraints:** React + Vite + TS; Express + TypeScript; MongoDB Atlas/Mongoose; Firebase Google Sign-In **plus** custom email/password; Groq Qwen as primary and Cloudflare free fallback only if validated; tested Kokoro + Web Speech API + Silero VAD voice; free 1×15min/month; sandbox ₹250/10, ₹500/25, ₹1000/50 monthly interview credits; admin/VIP; ₹0 non-SMS services. The gateway and platform must not cause billed inference.

## 1. Roles, permissions and workflow

| Role | Agent A — Backend & Infrastructure | Agent B — Frontend & Voice/UX | Integrator (developer/ChatGPT review) |
|---|---|---|---|
| Primary work | API modules, DB, auth, quota ledger, LLM adapters, state machine, authorization, unit/integration tests | React UI, accessibility, interview UX, media hooks, coding editor, reports, admin UI, frontend tests | Define/freeze contracts, approve ADRs, run CI, review security/data flow, merge PRs |
| Default write ownership | `apps/api/**`, `packages/contracts/**`, `.github/**`, root toolchain and `package-lock.json` | `apps/web/**` and frontend-specific static assets | `docs/ARCHITECTURE.md`, canonical requirements, release notes, merge/version changes |
| Read-only | `apps/web/**`, except code review | `apps/api/**`, `packages/contracts/**`, root lockfile | Everything |

**No shared working directory.** Each agent gets its own Git worktree, branch, running dev process and separate local env files. Agents may read the other lane, but may not alter owned files without an integration ticket.

**Avoid concurrent API changes:** Agent A owns canonical Zod DTOs and API contracts. Agent B uses the frozen v1 contract or mocks; contract changes require a short RFC/PR reviewed before either agent codes against them. Both agents should avoid global mass-formatting outside their owned paths.

**No silent dependencies:** Agent B records new root/shared dependency requirements in `apps/web/DEPENDENCY_REQUESTS.md`. Agent A or Integrator updates the root package lock **after merging**, not in two worktrees at once. B may edit its own `apps/web/package.json` as necessary.

**Safety:** No agents should put real API keys, user data, recordings or credentials into commits, issue descriptions, terminal logs or PRs. No real payment transactions. All cloud usage remains free except explicitly authorized SMS credits.

## 2. One-time bootstrap (sequential, small)

Because the application repository does not yet exist, **Agent A first performs P1-FND-01 bootstrap only**: initialize Git, npm workspaces (`apps/web`, `apps/api`, `packages/contracts`), root scripts/lockfile, baseline strict TypeScript/tooling, and minimal empty app folders. Implement a very small compilable `packages/contracts` initial health/error DTO so frontend is not blocked. Run `npm ci`, typecheck and lint and commit as `chore: bootstrap typed monorepo`. Integrator reviews and lands to `main`. **Only then start the two agents in parallel.**

Example Git commands run from the bootstrapped repo's **parent directory** (replace paths with the actual repository path):

```bash
cd /path/to/ai-interviewer
# Ensure main is committed and clean first.
git worktree add -b agent/backend ../ai-interviewer-backend main
git worktree add -b agent/frontend ../ai-interviewer-frontend main
# Open each worktree in its own IDE window or terminal, one coding agent per window.
```

Branches: `agent/backend` and `agent/frontend` (or issue-scoped branches cut from the latest `main`); worktrees are distinct folders sharing the same Git history. Each agent commits only to its branch. Use pull requests and GitHub Actions, **never push to main directly**. PRs should target a short reviewable work unit, not entire phases. Branches must be updated/rebased only between tasks, with clean worktrees. After merging, reconcile the other branch to `main` before integration testing.

**Run requirements:** Separate frontend and API ports where appropriate; never both agents writing the same MongoDB test database. Use isolated mock DBs, test envs or database-name namespaces.

## 3. Phase ownership map (each row preserves the original roadmap's sequence)

| Phase | Agent A — independent backend lane | Agent B — independent frontend lane | Merge/integration gate |
|---|---|---|---|
| **1 Foundation** | P1-FND-02 Express shell, -03 Zod shared DTOs, -04 Mongoose readiness, -06 API CI, -07 config/security | P1-FND-05 React/Vite UI shell + health states, frontend tests, CSS; no auth simulation | P1-FND-08 integrator: combined `npm ci`, lint, typecheck, test, build; UI fetches real `/health/live`; docs + evidence |
| **2 Identity** | User/identity/session models; Firebase token exchange; custom email+OTP; refresh rotation, RBAC/CSRF/abuse tests | Google/login/signup/verify/reset screens, authenticated route states, safe session UX | End-to-end Google and custom login in test env; account linking/auth bypass checks |
| **3 Entitlements** | Plan catalog; atomic quota reserve/commit/release; refunds; VIP and cooldown server gates | Pricing, quotas display, premium-locked content/paywall, session preflight states | Two concurrent starts cannot double-spend; Free/paid/VIP authorization tested |
| **4 AI + interview** | Groq/Cloudflare provider adapters, budgets/failover, interview state/event persistence, schema validation | Interview setup, topic-plan preview and transcript/turn UI using mock contracts | End-to-end text interview on real free provider, deterministic response ordering; integration metrics |
| **5 Voice** | Turn cancel/sequence API, persistent checkpoints, long-session recovery contracts | Port **validated** Kokoro + Silero + Web Speech pipeline; barge-in, transcript correction, device checks | Candidate completes real 15-minute voice session; interruptions don't play stale AI replies |
| **6 Proctoring** | Integrity incident reducer, warning escalation, cooldown, audit endpoints | MediaPipe/browser signal observers, full-screen and consent UI, warning banners | Exact anti-cheat policy scenarios pass, false-positive review |
| **7 Scoring/results** | Question rubrics, evaluation, aggregate score, entitlement-safe report endpoints | Free score card and paywall; premium detailed report UX, PDF presentation | Free API does not leak premium details; scoring quality reviewed |
| **8 Coding/personalization** | Code snapshots, resume/JD API, safe public GitHub inspection and caching | Monaco editor, resume/JD upload/review, coding feedback UI | Save/recover code, tailored questions; no untrusted code execution |
| **9 Premium** | Analytics aggregations, AI improvement-coach APIs, multi-round coordination | Skill charts, answer-retry UI, mock-onsite progression | Compare valid comparable sessions; no fabricated user stats |
| **10 Billing/admin/VIP** | Sandbox signed webhooks, idempotent billing, admin RBAC and audit, expiring invite backend | Admin UI, billing history UI, invitation management, VIP redemption UI | Replay-safe webhook; admin privilege tests; VIP access without payment |
| **11 Harden/deploy** | Deployment/config, privacy deletion/export, API load/security tests, incident runbooks | E2E Playwright flows, accessibility, browser soak, frontend perf | Combined full CI + staged manual checks + truthful demo evidence |

**Do not force parallelism where dependencies are hard.** A may need to finish initial contract types before B starts a feature. B can work with mock data **only** on frozen DTOs; all mocked screens must be clearly marked development-only. Phases 2–11 should be planned in smaller dependency-ordered task groups, rather than having B independently invent endpoints.

## 4. Phase 1 — first two simultaneous assignments

### Agent A ticket: `P1-BE-01` (after bootstrap)
- Files: `apps/api/**`, `packages/contracts/**`, `.github/workflows/ci.yml`, selected root tooling.
- Implement `GET /api/v1/health/live`, `GET /api/v1/health/ready`; API app factory; request IDs; JSON error structure; bounded payload sizes; security headers and explicit proxy configuration; mockable MongoDB readiness; schema validation; API tests; full root CI.
- Publish stable contract DTO exports, example payloads and API stub in `packages/contracts`; no auth yet.
- Exit: live 200 despite DB offline; ready 503 when unhealthy; 400/404/413/5xx sanitized errors; no secret logging; root CI passes.

### Agent B ticket: `P1-FE-01` (after bootstrap and contract tag)
- Files: `apps/web/**` only.
- Implement responsive React shell, minimal navigation placeholders Home/Interview/Dashboard/Pricing, real health/ready display via `fetch('/api/v1/health/live')`, accessible offline/error/loading states, Vite `/api` proxy and frontend tests. Admin entry is only a disabled placeholder until RBAC exists. Do not create fake users, payments, sessions or metrics.
- Use contract types from `packages/contracts` read-only; request contract edits through integrator. **Do not touch root package lock**.
- Exit: site works while API is up; stops API -> clearly shows offline; `npm run build` for web and web tests pass.

### Integration ticket: `P1-INT-01`
- Review both PRs, merge A then B (after conflict review), reconcile lockfile, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, manual browser health/offline, secret scan.
- Save actual stdout/exit codes, screenshots, commit hashes and limitations in `docs/TEST_EVIDENCE/phase-01.md`.
- Update tracker only after tests and approvals. No Phase 2 until this gate passes.

## 5. Agent communication and review protocol

**Task-start brief (every ticket):** scope, owner directories, read-only contract version, exact API request/response sample, dependencies, acceptance tests, out-of-scope items and expected output. Every agent first reads the canonical docs.

**Agent handoff (required):**
```
Ticket:                   Branch / Commit SHA:
Files modified:
Contract changes requested (if any):
Tests run + actual exit codes:
Security/privacy checks:
Manual checks/evidence:
Unverified or blocked:
Next integration dependency:
```

**Integration checklist:**
1. No cross-owned file edits, uncovered API drift or unreviewed DB schema change.
2. `npm ci && npm run lint && npm run typecheck && npm test && npm run build` all pass after merge (record exact commands).
3. No API key in git diff/logs/client bundle; no inaccessible admin routes unguarded.
4. Real browser smoke test for the feature and at least one failure test.
5. Merge PR with descriptive title and link to task and test evidence; update `IMPLEMENTATION_TRACKER.md`.

**Stop conditions:** Secret leak, billing charged, AI auto-upgraded to paid, unauthorized data/privilege exposure, corruption/race in credits, attempts to bypass provider free restrictions or critical tests failing.

## 6. Why this shortens delivery time

- Parallelize frontend/UI versus backend/domain logic once minimal contracts exist.
- Isolate both workspaces to avoid two agents overwriting code, lockfiles, local configs or git index.
- Reduce integration from large end-of-phase merges to small reviewed PRs.
- Preserve sequential gates for auth security, billing and session correctness; **two agents does not guarantee 2× speed**.

**NEXT ACTION:** Put the engineering pack in the new application repository's `docs/plan/`, run bootstrap as one small task, then launch Agent A (`P1-BE-01`) and Agent B (`P1-FE-01`) concurrently in separate worktrees. The prompts alongside this document are ready to paste into the two IDE agents.
