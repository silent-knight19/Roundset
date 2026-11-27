# P2-SPIKE-01 — Offline feasibility and baseline evidence

**Date:** 2026-11-27  
**Source baseline:** `4dd95d1963e89fc57ea9bd778f9cb5878343b68f` (main at time of inspection)  
**Scope:** credential-free portion of P2-SPIKE-01 only, per Phase 2 execution plan §5.  
**State:** PARTIAL — provider-account and deployment measurements UNVERIFIED.  
**Role:** implementation engineer; no independent acceptance or owner merge implied.

## 1. Observed execution evidence

Retrieved the completed, successful [CI run 46045381809](https://github.com/silent-knight19/Roundset/actions/runs/46045381809) at the exact source baseline. Inspected both jobs and the Verify & Test Monorepo job log. This is actual historical GitHub Actions execution, not a fresh local run or evidence about Atlas.

| Check | Observed result |
|---|---|
| npm ci, npm run lint, npm run typecheck, npm run build | Successful CI steps |
| npm test | 535 passed, 38 intentionally skipped for separate replica-set run |
| Password auth suite with disposable MongoDB 8.0 replica set | 8 passed |
| Identity/session suite with disposable replica set | 25 passed |
| OTP foundation suite with disposable replica set | 5 passed |
| Total | 573 passed across ordinary and separately executed integration suites |
| Disposable database preservation sentinel and cleanup | CI steps successful |
| npm audit --omit=dev | Successful; log reports zero vulnerabilities |
| npm audit --include=dev --json and native dependency smoke | Successful audit job |

CI commands are defined in [.github/workflows/ci.yml](../../.github/workflows/ci.yml); the three database suites use a disposable loopback rs0/roundset_test instance, not a shared or production database. No new test command was run locally (network DNS prevents cloning). This evidence establishes local replica-set coverage, not cloud transaction behavior or account capacity.

## 2. Public provider research (not account validation)

Official sources checked 2026-11-27:

| Provider | Current published constraint | Remaining gate |
|---|---|---|
| [MongoDB Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) and [cluster management](https://www.mongodb.com/docs/atlas/manage-clusters/) | Free sandbox replica set, one free cluster per project, limited capacity | Verify actual free project, allowlisted connection, unique/partial/TTL indexes, transaction rollback and concurrent write conflict behavior using isolated synthetic data. Do not enable paid backups or upgrades. |
| [Brevo Free plan](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) | 300 daily sends; transactional messages can be queued after quota exhaustion | Confirm account-specific remaining allowance and reset boundary. The approved general 180/day and recovery 60/day caps are not proof of provider reset alignment. Do not allow a queued/late OTP to be represented as timely inbox delivery. |
| [Brevo sender requirements](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders) and [domain authentication troubleshooting](https://help.brevo.com/hc/en-us/articles/16045394674066-Troubleshooting-Domain-authentication) | Public email domains cannot be authenticated by the user; Brevo may substitute a compliant sending address | Verify authorized sender, actual visible sender and inbox delivery inside five minutes with a controlled test address. No domain purchase, paid credit or assumption of delivery. |
| [Render compute plans](https://render.com/docs/compute-plans) and [Free services](https://render.com/docs/free) | Free web instance 0.1 CPU/512 MB; idle sleep after 15 minutes | Measure actual worker RSS and latency with Argon2 and database traffic under bounded concurrency; report cold start separately. Do not deploy or upgrade for this offline ticket. |
| [Firebase pricing](https://firebase.google.com/pricing), [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions) | Spark is the no-cost plan; basic token verification alone does not check revocation | Confirm actual Spark project, correct project ID, Google provider, verified email and checkRevoked verification; real browser and token tests pending. Do not link billing. |
| [Cloudflare Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) and [routing](https://developers.cloudflare.com/pages/functions/routing/) | Functions share Workers Free request allowance (100,000/day); exhaustion routing is configurable | Prove fail-closed API routing, ingress proof, separate Set-Cookie forwarding, no-store, CSP/COOP, refresh and direct Render denial with approved HTTPS deployment; no fail-open auth path. |

Public plan descriptions can change. Actual dashboard/account evidence is required before live activation. No external account was accessed, created or modified. No spend was authorized or incurred by this research.

## 3. Reproducible remaining acceptance checklist

All boxes below remain unchecked. This is a protocol, not an assertion of a passed test.

- [ ] **Atlas:** record free tier and sanitized target identity; use a separate approved synthetic database, narrowly allowlisted connection, exact index verifier, rollback, uniqueness and competing-write tests. Never point the existing loopback-only destructive CI fixture at Atlas. Do not loosen its isolation guard. Record command, outcome and cleanup.
- [ ] **Brevo:** record Free plan, authorized sender and actual quota reset semantics, including time zone and other sends sharing the allowance. Deliver one synthetic OTP to a controlled inbox; record provider acceptance and arrival timestamps separately, validate usability within the approved five-minute expiry, confirm sender and no actual OTP/token in evidence. Failure means live email remains blocked.
- [ ] **Render:** record actual free compute limits. Existing `apps/api/tests/password-benchmark.ts` exercises bounded hashing (two active, eight queued) but a local benchmark cannot establish free-instance headroom. Measure RSS under representative API/database load and contention; record latency, queue rejection, restart and memory evidence on approved free runtime.
- [ ] **HTTPS:** on an approved test origin verify proxy proof and rejected direct traffic, independent Set-Cookie forwarding, first-party host-only cookie attributes, signed CSRF, Origin/Fetch Metadata and browser refresh in Chromium and Safari, plus CSP/COOP Google popup behavior.
- [ ] **Firebase:** verify actual approved Spark configuration; test real Google exchange after implementation, invalid/revoked token denial and account collision behavior; verify no paid fallback or billing.
- [ ] **Release:** document provider quotas and reset clocks, disabled state for unverified live routes, no paid activation; independent acceptance after applicable evidence.

## 4. Governance and disposition

- PR #15 is merged, but its PR body explicitly records outstanding independent security acceptance and six CodeQL missing-rate-limiting alerts. Owner has stated they are false positives; no independent alert closure or dismissal is established here. This document neither changes that disposition nor authorizes a dependent ticket.
- P2-AUTH-02 and P2-AUTH-06 require accepted upstream identity/session/OTP work as applicable. P2-AUTH-07a additionally requires accepted A02 and A03b. P2-FE-03/04 depend on those later tickets. P2-AUTH-04b requires the approved sender and A04a acceptance. Do not confuse ability to write mock code with authorization to bypass those prerequisites.
- Only this new evidence file is in scope. No application code, contracts, architecture, workflow, tracker checkbox, dependencies, secrets or provider settings changed. No deployment, merge or production activation. An independent reviewer and the owner retain their required approval and merge authorities.
- Evidence limitation: no live provider accounts, no local checkout, no actual device/browser run and no new local tests. The baseline CI checks above are observed results only. Document changes require their own PR checks; no claim of future or unobserved results.
- Architecture deviations: none. P2-SPIKE-01 remains PARTIAL / BLOCKED FOR LIVE RELEASE.
