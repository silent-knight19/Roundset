# Roundset — Phase 2 Identity: Dependency-Ordered Execution Plan v1.2

**D3 DOCUMENTATION APPROVAL CANDIDATE. NO IMPLEMENTATION AUTHORIZATION UNTIL OWNER MERGE.**  
**Baseline:** `main@36e9f590d297681987ded1a6028898c026686230`.  
**Authority:** `AGENTS.md`; Phase 1 merged PR #4; `docs/IMPLEMENTATION_TRACKER.md`; Master Roadmap; parallel two-agent plan.  
**References:** [`P2_DESIGN_01_AUTH_ARCHITECTURE.md`](../phase2/P2_DESIGN_01_AUTH_ARCHITECTURE.md), [`P2_AUTH_API_CONTRACTS_v1.md`](../phase2/P2_AUTH_API_CONTRACTS_v1.md), and ADR-028.

## 1. Correct gate sequence

| Gate | Owner | Required evidence | Exit |
|---|---|---|---|
| **D1 — Contract correction** | Principal Architect | V-01..V-16 disposition; exact auth routes, DTOs, Mongo indexes, registration/OTP/reauth/logout/replay transactions, Chrome/edge security, cost guardrails; reconcile older ADR-018/023/027 terminology | Contract marked internally coherent **for independent review**, not accepted for implementation |
| **D2 — Adversarial review** | Independent reviewer(s) + Principal Architect | Targeted review of **revised** flows; reproduce design counterexamples in paper-based interleavings; no severity inflation or unverified exploit claims; each real finding resolved | No unresolved *design* defect that permits account pre-hijack, factorless account, session takeover, privilege escalation or OTP double-use |
| **D3 — Owner approval and docs-only merge** | Project owner | Versioned ADR-028, approved architecture/contracts/plan, canonical docs precedence clarified, owner authorizes docs-only PR, GitHub governance configured | **Only here** may first auth coding task move from BACKLOG to READY |

**Do not ask implementation agents to write auth routes, models, cookies, JWT, OTP or frontend login UI until D3.** A new independent review is not a substitute for the owner's signoff and exact versioned artifact.

## 2. Repository and ownership prerequisites

- Repository is **public**; GitHub branch API reports `main.protected=false`. GitHub Free supports protection on public repositories. Configure `main`: require pull request for merges and passing CI; prevent force pushes/deletions. For a solo-owner repository, do not require a GitHub approval count that the only committer cannot satisfy; record the independent ChatGPT engineering review in the PR discussion/evidence and retain explicit owner merge authority. Verify branch state after change. No need for a paid GitHub plan.
- Agent A owns `apps/api/**` and `packages/contracts/**`; Agent B owns `apps/web/**`; integrator/architect owns ADRs, canonical docs and shared root lockfile; as `docs/plan/PARALLEL_AGENT_EXECUTION_PLAN_v1.md` states. Separate worktrees, no overlapping writes, no direct pushes to main, one authorized atomic ticket at a time.
- Existing `.env.example` includes a placeholder `ADMIN_BOOTSTRAP_EMAIL`, but actual bootstrap must be an operator CLI against verified user ID with audit; this placeholder cannot grant privilege. Existing API `security.ts` Origin/CSRF rules are *foundation*, not completed auth security.
- Retain existing 75-test regression baseline; those historical results are **not** new Phase 2 test evidence. Do not mark a new test pass without execution.

## 3. Dependency DAG

```text
D1 revised design -> D2 independent challenge -> D3 owner-approved docs-only PR
                                                      |
                               +----------------------+---------------------+
                               |                                            |
                       P2-AUTH-01 A01                              P2-FE-01 B01
                     models/indexes/contracts                      auth UI shell DTO-only
                               |
                 +-------------+----------------+
                 |                              |
           P2-AUTH-05a A05a               P2-AUTH-03a A03a
         sessions, Origin, CSRF,           Argon2 benchmark + bounded
         ingress and keyrings             primitive (no routes yet)
                 |                              |
                 +---------------+--------------+
                                 |
                         P2-AUTH-04a A04a
                      OTP/pending registrations/
                    rate limits/local email mock
                                 |
                    +------------+------------+
                    |                         |
           P2-AUTH-03b A03b               P2-AUTH-02 A02
          password registration,           Firebase Google verifier,
          verify/login/reset        exchange, admission
                    |                         |
                    +------------+------------+
                                 |
                       P2-AUTH-07a A07a
                   action-bound reauth/link/unlink;
                  password/change; last-factor safety
                                 |
                       P2-AUTH-07b A07b
                   self profile, consent, export,
                    deletion, devices and revocation
                                 |
                            P2-INT-01
                      integrated security review

Independent constrained paths after A01, A05a and A04a:
  P2-AUTH-06 A06: mock-only phone contact (must not enable paid SMS)
  P2-AUTH-04b A04b: Brevo HTTPS adapter + actual ₹0 delivery evidence
  P2-FE-02 B02: token client/route state, after A05a contract acceptance
  P2-FE-03 B03: Google/link UX, after A02 and A07a
  P2-FE-04 B04: profile/devices UI, after A07b

P2-SPIKE-01 (no paid deployment, manual/provider research) occurs
as early as credentials and zero-cost accounts are available; it is a
release-risk gate for A04b/INT, not a prerequisite to writing A01.
```

**Endpoint owner freeze:** `P2-AUTH-05a` alone implements `GET /auth/meta`, `POST /auth/refresh`, `POST /auth/logout` and `POST /auth/logout-all`, with frozen DTO fixtures used by downstream A02/A03b/A07a. `P2-AUTH-07a` owns `/auth/reauth` and `/auth/password/change`, while `P2-AUTH-07b` owns the operator-only ADMIN seed and audit. Never duplicate route implementations across tickets.

**Dependency-cycle correction:** `P2-AUTH-03b` implements registration, email verification, login, forgot and reset only. `POST /auth/reauth` and all action-bound operations, **including `/auth/password/change`**, are in `P2-AUTH-07a`; never require unimplemented step-up in an earlier atomic ticket. Cross-agent frozen DTOs updated as part of D3, not improvised.

An independent frontend ticket may be coded only **after D3**, with fully frozen DTO fixtures and **no self-invented endpoint**; it cannot count as authentication completion until integrated with the real backend. Agent A must not modify Agent B UI without integration authorization.

## 4. Task contracts (no task is READY yet)

| Ticket | Requires | Agent / owned files | Exact scope and must-pass condition |
|---|---|---|---|
| `P2-AUTH-01` (`A01`) | D3 | A: `apps/api/src/modules/identity/models/**`, `packages/contracts/src/auth/**`, tests | Zod auth.v1 schemas, `pendingRegistrations`, users, identities, sessions, OTP challenges, reauthTickets, rate/email budget, allowlist and audit models with exact verified indexes. No HTTP auth routes or secret issuance. Real replica-set index tests, unique-null/duplicate-state cases, mock DB rejected as production evidence. `users` has no PENDING_EMAIL; no orphan identity. |
| `P2-AUTH-05a` (`A05a`) | A01 accepted | A: `apps/api/src/modules/auth/session/**`, `core/security.ts`, `app.ts`, config and tests | EdDSA JWT keyring; opaque refresh HMAC `kid`, CAS single successor, epoch/status guard, signed session-bound CSRF, role-dependent aligned refresh/CSRF cookie TTL, origin and proxy ingress policies, safe errors and key-rotation tests. No real login until identities implemented. Direct Render spoof and no-Origin health regression must pass. |
| `P2-AUTH-03a` (`A03a`) | A01 accepted | A: `apps/api/src/modules/auth/password/**`, performance tests | Argon2id wrapper, initial 19 MiB/t2/p1, max two concurrent hashes, queue <=8, <=3s queued, dummy known-unknown path, max password bytes. Actual memory measurements recorded; no network routes. |
| `P2-AUTH-04a` (`A04a`) | A01, A05a accepted | A: pending-reg/OTP/email mock/rate middleware and tests | One slot per purpose/subject; CAS generation/attempt/delivery, 5-minute six-digit OTP; secure browser-bound pending registration and non-issuance of sessions; mock EmailSender dev-only; persistent Mongo per-account rate caps and in-process flood shedding. Transaction/rollback tests; recovery OTP stores userId, passwordIdentityIdAtIssue, identityVersionAtIssue, and cannot verify after credential changes; cannot verify undelivered, expired or superseded code. |
| `P2-AUTH-03b` (`A03b`) | A03a, A04a, A05a | A: custom password auth routes, owned contracts/tests | `register→verify(204)→login`, password forgot/reset (NO change route here; reauth does not exist yet); no activation of attacker's pending password; no OTP-only session. Password reset globally invalidates sessions; recovery challenge is bound to immutable `userId`, `passwordIdentityId` and `identityVersionAtIssue`. Uniform forgotten/invalid error, enforced numeric rate caps, no secrets. |
| `P2-AUTH-02` (`A02`) | A01, A05a, A04a | A: Firebase adapter, Google exchange, tests | Firebase Admin correct project, provider Google, email verified, UID identity lookup, GET /auth/meta active consent for first-use only, returning-user consent optional, admission and pending-register collision handling. No email-only merge. Fresh provider `auth_time` proof support; bounded failure handling. Real Firebase tests optional manual with real project before integration completion. |
| `P2-AUTH-07a` (`A07a`) | A02, A03b accepted | A: step-up tickets, password change, linking/unlinking, tests | Action/session/target/**methodUsed**/epoch/version-scoped reauthTickets; **implement `POST /auth/password/change` here**, after `/auth/reauth`; dedicated LINK_PASSWORD OTP start/complete; same-email verified Google linking; atomic ticket use and shared-user identityVersion writes; unlink remaining-factor proof and global epoch invalidation. Concurrent unlink and cross-user ticket attack tests. |
| `P2-AUTH-07b` (`A07b`) | A07a accepted | A: profile, self-export/deletion, device sessions, CLI seed, tests | `/me`, consent, sessions, self-only export, delete state/purge runbook, Firebase cleanup retry, no admin self-promotion, role/status epoch revocation, operator-only audited admin seed. No Phase 10 admin console, no unapproved VIP/billing changes. |
| `P2-AUTH-06` (`A06`) | A01, A04a accepted | A: SMS adapter, mock, contact record tests | Verified contact only, no phone login, mock clearly labelled and forbidden in production as real send; actual paid SMS gateway forbidden until explicit exception. |
| `P2-AUTH-04b` (`A04b`) | A04a accepted; user-configured approved free sender | A: Brevo HTTP adapter/config/test evidence | No paid SMTP; HTTPS API with error timeouts and safe logs; crash-safe atomic general/recovery email attempt budgets; real free sender and inbox OTP tested using non-sensitive test account, no assumed free-domain capability. If account cannot deliver at ₹0, **live email-auth release blocked**, do not add paid domain. |
| `P2-FE-01` (`B01`) | D3 approved contracts | B: `apps/web/**` owned auth pages | Accessible signup, login, verify, reset, public consent policy discovery and error/429/offline states; unimplemented services truthfully labelled; no fake users or stored access JWT. |
| `P2-FE-02` (`B02`) | A05a accepted contract | B: auth client/context, route guards | Memory-only Bearer access JWT; signed-readable CSRF cookie read, refresh bootstrap, Web Locks/BroadcastChannel single-flight when supported, conservative relogin on uncertain refresh, no browser token storage, no UI-only authorization claims. |
| `P2-FE-03` (`B03`) | A02, A07a accepted | B: Google/login/link UX | Actual Firebase Google button/exchange, fresh popup reauth for step-up, same-email link UX, popup/CSP/COOP tested in HTTPS browser; no Firebase email/password substitution. |
| `P2-FE-04` (`B04`) | A07b accepted | B: self profile/consent/devices screens | Own-profile/security, linked providers, device revoke, logout-all, export/delete with step-up; admin UI remains disabled. |
| `P2-INT-01` | All applicable accepted; optional real SMS deferred | Integrator | Full fresh-clone CI, real Mongo transaction and uniqueness, Firebase test account, Brevo free inbox if live email release, HTTPS cookie/proxy and frontend browser tests; security review and exact test evidence, owner merge. |

For every ticket, issue a *separate* architect-authored authorization containing exact owned files, permitted dependency additions, request/response DTO version, branch/worktree name, negative tests, and report format. This plan **is not** such authorization.

## 5. Early provider feasibility, without misclassifying untested risks

**P2-SPIKE-01** (manual, low-cost validation only; no auth application code):

1. Confirm Atlas Free connection and representative replica-set transaction/index support with synthetic records, including write conflicts. Record actual account/tier and operation evidence. No production data or paid upgrade.
2. Verify whether the user's available Brevo account can authorize a sender and deliver an OTP to a controlled inbox entirely at ₹0; verify 5-minute usability, not just HTTP 2xx. Keep fallback mock **development-only** until proven. This is a release blocker if failed, not a reason to buy a domain.
3. When deployment candidates exist, test Pages→Render secret ingress, first-party multi-Set-Cookie forwarding, Chromium/Safari login refresh, COOP, CSP and independent direct Render rejection. Single-origin Render remains permitted no-purchase fallback; change between candidates requires documented approval and deployment evidence.
4. Measure Argon2 worker peak RSS and latency at the actual free-memory bound and auth/Atlas ops under bounded concurrency. Don't state that any specific number of concurrent attempts **has** caused OOM until measured.
5. Obtain current provider quotas/pricing from actual dashboards and lock production config fail-closed; never enable paid fallback or auto-upgrade.

Failure of these spikes is recorded as **UNVERIFIED/BLOCKED FOR DEPLOYMENT**, not as a fabricated exploit or a retrospective invalidation of the Phase 1 tests.

**D3 doc-only merge prerequisite:** Confirm current GitHub `main` SHA before PR; this plan and new ADR/contract apply only after owner approval. No optional phone/SMS or live delivery is silently enabled.

## 6. Security and test acceptance matrix

| Risk / test | Phase gate |
|---|---|
| Unverified registration hijacking, verifying wrong nonce, Google pending collision, race in dual signup, durable register/resend cooldown | A04a, A03b, A02, integration |
| Duplicate email/UID, invalid partial/unique indexes, null refresh digest, one active OTP, missing index boot | A01, A04a, integration |
| CSRF/session mismatch, pre-session registration cookie rules, absent browser Origin, production `INGRESS_MODE=LOCAL` rejected, dual edge-secret rollover, redirect/hop headers, direct Render forgery, two Set-Cookie headers, health-without-Origin | A05a, integration |
| Two simultaneous refreshes, MAC forgery vs authentic old token, CAS lost response, signing/HMAC key rotation | A05a, B02, integration |
| Google provider project/UID, email equality, stale `auth_time` vs new `iat` | A02, A07a, B03 |
| Missing LINK_PASSWORD OTP issuance, purpose confusion, single-use reauth action/target/**method**, recent Google new-link proof, concurrent unlink of both factors | A04a, A07a |
| Recovery challenge issued before password change/reset/unlink/deletion/re-registration never authorizes later credential, including userId/version mismatch; role/status mutation revocation; no cross-account session/profile/export/delete | A03b, A07a, A07b |
| Argon2 bound + numeric persistent abuse counters, durable registration replacement cooldown, crash-safe general/recovery email caps, global-prelookup provider status, account-enumeration timing distributions | A03a, A04a, A04b, integration |
| Safe privacy export, consent versions/timestamps, audited and retryable deletion/provider cleanup, no secrets in logs | A07b, integration |
| React memory-only JWT, UI honest states, Google returning-user consent optional/policy discovery, popup compatibility, valid first-party cookies on selected origin | B01–B04, integration |

**Every PR requires observed commands and exit codes (not historical results):**

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
git diff --check
```

Add an approved no-cost secret-scanning step/tool (e.g. pinned gitleaks action) through a separately reviewed CI/toolchain change; meanwhile inspect committed diff/history and block credential leaks. Do not silently add new root dependencies or make a check pass by bypassing it. Review CodeQL and any available GitHub security alerts with actual evidence.

**Hard-stop criteria:** unauthorized account merging; an attacker-selected password activated by someone else's verification; successful last-factor unlink; non-single-use reauth/OTP; forged refresh revokes victim; CSR/origin bypass; admin role escalation; stolen private data/secret in logs; mock email/SMS treated as live; paid third-party service used; failure of actual required tests.

## 7. Documentation-only merge plan (D3, owner approval required)

```text
docs/phase2/P2_DESIGN_01_AUTH_ARCHITECTURE.md
  <- approved version of architecture v1.2 review candidate

docs/phase2/P2_AUTH_API_CONTRACTS_v1.md
  <- approved version of auth contract v1.2 review candidate

docs/plan/PHASE_02_IDENTITY_EXECUTION_PLAN.md
  <- approved version of this execution plan

docs/ADR/ADR-028-auth-identity-linking-and-sessions.md
  <- explicit approved decisions, references ADR-018/023/027

docs/API_AND_DATA_CONTRACTS.md
  <- link canonical Phase 2 v1 and resolve old fields/endpoint contradictions

docs/ARCHITECTURE.md
  <- reference approved design but keep Phase 2 implementation unbuilt

docs/IMPLEMENTATION_TRACKER.md
  <- record D3 only, leave all P2-AUTH checkboxes unchecked

docs/plan/PARALLEL_AGENT_EXECUTION_PLAN_v1.md
  <- correct obsolete Phase 1 NEXT ACTION only if approved by owner
```

**D1/D2 completed at design level. D3 awaits owner-reviewed documentation-only PR merge; no Phase 2 authentication code is authorized before merge.**

## 8. Current verdict

**D1:** Revised v1.2 review candidates prepared; internal consistency checked, not owner-approved.  
**D2:** Independent v1.2 adversarial review completed; supported final-delta corrections incorporated in D3 candidate. No additional broad review cycle.  
**D3:** Pending owner approval and documentation-only PR.  
**All P2-AUTH / P2-FE tickets:** BACKLOG / BLOCKED.  
**GitHub source-code files changed:** None (D3 documentation-only PR may add/change docs).  
**Existing Phase 1 code changed:** None.  
**Next authorized activity:** owner approval and merge of D3 documentation PR; then separately authorize P2-AUTH-01.
