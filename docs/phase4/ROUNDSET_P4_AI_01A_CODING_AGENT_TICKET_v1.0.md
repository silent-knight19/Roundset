# Coding-Agent Ticket — Roundset P4-AI-01a
**Task ID:** `P4-AI-01a`  
**Goal:** Implement typed, deterministic, **strictly offline** AI gateway contract and authoritative source-provenance validation foundation.  
**Branch:** create `feat/p4-ai-01a-offline-gateway-contract` from verified current `main` (dedicated worktree if other agents run).  
**Architecture authority:** `ROUNDSET_PHASE4_ARCHITECTURE_v1.0_IMPLEMENTATION_BASELINE.md`, §§3–6, 12–14; `ROUNDSET_PHASE4_FINAL_DECISIONS_AND_GATES_v1.0.md`; repo `AGENTS.md` and ADR-017/019/021/027/028.

## Preparation

1. Inspect `AGENTS.md`, current `main`, open PRs, `apps/api/src/`, `packages/contracts/`, root package lock and existing Vitest conventions. Avoid clobbering P2/P3 or P5 branches.
2. Ensure the full frozen baseline docs are accessible; include the frozen Markdown files under `docs/phase4/` **only when owner/architect provides them**. Do not reconstruct the architecture from memory or silently rewrite it.
3. One task only. Do **not** implement a real database, provider account, quota reservation, API endpoint, auth middleware, LLM SDK or frontend UI in this PR.

## Allowed source ownership

- New internal modules under `apps/api/src/modules/ai/` only, plus focused `apps/api/tests/p4-ai-01a-*.test.ts` tests.
- If required for direct Zod import, it is permitted to add the **already-used monorepo version** of `zod` (currently `4.6.7`) as an explicit `apps/api` runtime dependency, updating lockfile; no additional library or package versions without approval.
- No `packages/contracts` changes in this ticket: the interface is internal-only, not a public/client DTO.

## Implement

**A. Typed internal contracts**

- `Purpose`: PLAN, START_BUNDLE, QUESTION, FOLLOW_UP, CONTEXT_SUMMARY; reserve P7 EVALUATION/REPORT without implementing them.
- `ProviderId`: GROQ, CLOUDFLARE, MOCK. **All physical egress remains absent.**
- `DataClass`: SYNTHETIC, USER_TRANSCRIPT, USER_DOCUMENT.
- `GenerationIntent`, `SourceDescriptor`, `NormalizedGenerationResult`, typed sanitized gateway errors as specified in v1.0 §4.
- `SourceDescriptor.scope` is discriminated: SERVER_TEMPLATE (registered template ID/version), SYNTHETIC_FIXTURE (registered fixture ID/version), USER_INTERVIEW (current `userId`, current `interviewId`, record ID/version). Descriptors are claims, not proof.

**B. Authoritative resolver abstraction**

- Pure `resolveAndAuthorizeSourceManifest({authenticatedUserId,interviewId,parts,descriptors}, resolver)` with injected **authoritative resolver interface**. This ticket implements a deterministic fake resolver for tests, **not** a Mongo implementation.
- For USER_INTERVIEW roots, require resolver-returned authoritative user, interview, immutable record identity/version, kind, and complete lineage. Reject missing sources, foreign owner, same-owner different-interview, mismatched versions, duplicate ambiguous refs, cycles, dangling ancestor references, or mixed-scope derived summaries.
- For trusted templates, resolve against registered immutable server templates. For synthetic fixture, resolve against registered fixture allowlist, never user data. Do not accept a mere `scope` label as sufficient authorization.
- Derive canonical all-of `dataClasses` from every message part plus recursive summary ancestry. Unknown provenance fails closed; SYNTHETIC cannot coexist with real classes. Candidate configuration is USER_TRANSCRIPT, even if normalized to enum tags. Do not trust caller-selected labels.
- Verify a supplied `GenerationIntent.dataClasses` equals canonical recomputation; on mismatch reject. Separate provider-specific eligibility/consent predicate is an **injected mock** for now. No real P2 API.
- Keep raw source content, refs, unsalted hashes, transcript and credential values out of exceptions/logs.

**C. Deterministic gateway mock**

- Stable seeded outcomes per purpose and fixture; simulate success, schema-invalid/truncated, timeout, stale source, unsupported model and failed class-consent as typed/sanitized results.
- No network fetch, child process, real secret, timers polling a provider, Mongo writes, Express routing or paid account use.
- Deterministically prove the PRE_START and POST_START cutoff functions refuse missing/expired dates and never access `effectiveDeadlineAt` in PRE_START.
- Test validation and model *proposal* boundary; never let mock output decide quota, authorization, grades or account status.

## Required tests (all offline)

1. A-owned response and same-interview summary with correctly inherited classes succeeds under an approving fake policy.
2. A request illegally references B's transcript/summary under colliding slot ID; both principals have USER_TRANSCRIPT consent. **Must reject before mock dispatch.**
3. Same-user other-interview source rejects; user-scope metadata spoofing rejects against resolver records.
4. Derived summary referencing foreign/private wrong-scope ancestor rejects; cyclic and missing ancestry rejects.
5. Mixed USER_TRANSCRIPT + USER_DOCUMENT requires all-of both permissions; reverse missing permission denies; synthetic+real denies.
6. Registered purely synthetic fixture succeeds; unregistered fixture and static text mislabelled SYNTHETIC fail.
7. Caller changes `dataClasses`/manifest between attempts; stale permit/class downgrade denied (mock-only receipt check).
8. `PRE_START` considers READY/reservation/lease/request deadlines with no startedAt; POST_START requires effective deadline and hard cap; expired/NaN timestamps fail closed.
9. Mock does not include private rubric/prompt text or exception details in sanitized errors or logs. All generated data for tests is synthetic.
10. Unknown/fallback/repair calls must re-evaluate policy independently; no implicit Cloudflare enabling.

## Acceptance and handoff

- Full root monorepo verification: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`, `git diff --check`. Give actual counts, skips, exit codes, CI URL and SHA.
- List files changed and any dependency changes. Include one concise test matrix mapping the 10 cases to actual test names, especially foreign-source rejection.
- Confirm **zero HTTP provider calls, zero candidate/private data, zero Mongo mutations, zero P2/P3 contract changes, no public endpoint or client bundle additions**.
- Do not claim future privacy/Atlas/provider functionality implemented by mocks.
- Open PR against current `main`, leave unmerged, return report for independent architect review. **Do not start AI-01b or other dependent ticket.**
