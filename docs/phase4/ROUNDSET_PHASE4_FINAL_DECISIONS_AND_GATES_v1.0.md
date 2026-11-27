# Roundset — Phase 4 v1.0 Final Decision Register and Release Gates
**Date:** 2026-11-23  
**Status:** Final architect technical baseline. Owner merge/payment/private-data-release authority retained.  
**Source authority:** Full `ROUNDSET_PHASE4_ARCHITECTURE_v1.0_IMPLEMENTATION_BASELINE.md`; previous v0.6 final external audit; current repository ADR and auth contracts.

## 1. Review loop terminated

- Six successive external document review rounds culminated in **0 Critical / 0 High / 2 Medium / 1 Low**. Those final issues are now resolved in the baseline and this register; they were **specification ambiguities, not observed deployed exploits**.
- **R6-M01 — closed:** All private prompt root sources must be looked up by an authoritative `userId` **and** `interviewId` plus record/version, and descendants inherit that scope. An untrusted/incorrect global-cache hit is rejected before provider admission. Provider-specific consent class checks are necessary but not sufficient.
- **R6-M02 — closed by explicit business semantics:** When the **single atomic Q1/P3 transaction commits**, the monthly credit and timer are attributed to its `startDecisionAt`, sampled late in that transaction, not commit ACK/physical visibility time. A transaction completing across midnight can count toward the earlier period **only if** its business-effective timestamp was lawful and the transaction committed. Explicit 30-second cutoff guard reduces confusing edge events but is **not** a mathematical commit-time guarantee. If this UX convention is unacceptable, an owner product policy change (not another general audit) is required.
- **R6-L01 — closed:** Contract → pure AI-01a mocks → AI-01b account budget → INT-01 claim CAS → AI-01c private integration. No circular dependency.

## 2. Frozen technical defaults and product behavior

| ID | Working implementation decision | Unverified release condition |
|---|---|---|
| D-01 | Node 22 / Express 5 / TypeScript / Mongo Atlas Free modular monolith; no Redis, paid queue, cron or extra backend | Atlas performance and transaction tests |
| D-02 | Groq `qwen/qwen3.8-27b` primary; Cloudflare same-Qwen flag **OFF**. No model substitution or paid fallback | Live synthetic Groq compatibility, availability and privacy tests |
| D-03 | Pure gateway adapter internal contracts; all source classification/ownership from trusted backend records, never client labels | Private source resolver integration and authorization tests |
| D-04 | Candidate P4 uses current P2 memory-only Bearer; cookies/CSRF only P2 refresh/logout; real P2 user/session write fence in every private P4 mutation | Accepted P2 API, real Mongo conflicts/expiry/deletion tests |
| D-05 | PRE_START time uses READY/reservation/lease/request deadlines; `startedAt` exists only after Q1/P3 atomic commit | Real READY expiry / period tests |
| D-06 | Business-effective `startDecisionAt` stamps startedAt, P3 month, Q1 receipt and deadline on a **committed** transaction; **30s** initial expiry/month guard band, fail closed when insufficient headroom; no false physical commit-time guarantee | Atlas benchmark, UX wording, delayed-ACK and month-end tests |
| D-07 | **One** nonterminal candidate interview slot per user is selected as the architect's ₹0 resource default; owner-visible action ID returned for recoverable slot; create lazily reconciles overdue records | Owner must confirm O-09 before public enforcement of this policy |
| D-08 | No permanently running worker: owner invocation/next mutation drives bounded reconcile; GET never sends model requests | Deployment cold-start tests, O-11 owner disclosure |
| D-09 | Free monthly 15-minute 1 credit; P3 controls reserve/commit/release/refund; no hidden second P4 credit ledger | P3 accepted shared `ClientSession` APIs |
| D-10 | Provider admission, synthetic and private, draws from a single *real provider tenant* account budget; synthetic has stricter subcap; never assume separate API keys have separate quotas | Account actual rate limits, no-paid plan/dashboard settings |
| D-11 | All free/premium public DTO allowlists exclude rubric and scoring details; P7 owns grading/reports | P7 DTO integration, privacy tests |
| D-12 | Recovery never credits browser absence; only verified outage interval union, bounded pause and conservative usage | O-02 exact coverage/refund/grace policy before candidate release |

**Default proposal for numeric policy discussions (not a deployment claim):** 5-minute PREFLIGHT TTL, 3-minute READY TTL, 90-second START lease bounded by the smaller READY/period expiry, 120-second maximum *verified* platform pause. These are conservative initial product values **requiring owner approval in O-02/O-10** and real load testing before an end-user guarantee. The 30-second commit headroom guard is a frozen technical fail-closed default, not a promise that Mongo physically commits before cutoff.

## 3. External gates: remain blocking only for the affected functionality

| Gate | Required evidence / approval | May mock-only AI-01a proceed? |
|---|---|---|
| G-P2 | Accepted P2 user+session transactional mutation fence and tested real JWT/Origin/consent integration | **Yes** |
| G-P3 | Accepted P3 shared-ClientSession reserve/commit/release/refund and real index/transaction tests | **Yes** |
| G-DB | Real Atlas replica-set tests (dedicated `roundset_test` or separately isolated P4 test DB, authorized IP access only), write-conflict/unknown commit/period tests | **Yes** |
| G-PROVIDER | Owner-authorized Groq synthetic account, no-paid setup, actual model and quota evidence, account-wide budget admission | **Yes** |
| G-PRIVACY | Owner-approved O-04/O-05 Groq account data controls/ZDR or accepted retention, consent copy, all-of classes, source-owner scopes, export/deletion/purge and post-permit withdrawal semantics | **Yes**, but **no private egress** |
| G-POLICY | Owner confirms O-02/O-06/O-09/O-10/O-11/O-12 UX and policy defaults, route version and activation | **Yes** |
| G-QUALITY | Reviewable source PR, tests/CI, no unapproved dependencies or architecture change, owner merge | **Yes** |

**Do not confuse architecture freeze with deployment approval.** The owner still decides policy acceptance and merges. The architect can approve mock-only isolated coding without private inference or external account access.

## 4. Stop conditions and change control

- Reopen **only a specific failing invariant** when an integration test, source code, provider change, or owner requirement demonstrates it. Do not request another open-ended external architecture review.
- Any change to model choice, payments, quotas, session/privacy behavior, data retention, infrastructure or billing requires owner/architect change control; agents may not silently revise.
- If required evidence cannot be obtained on a ₹0 account, fail closed / defer the relevant feature; do not create paid resources automatically.
