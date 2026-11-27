# Roundset Phase 4 v0.6 — Independent External Architecture Re-Audit

**Review date:** 2026-11-23  
**Verdict:** **APPROVE WITH CONDITIONS — architecture design only; owner contract freeze not yet granted.**  
**Severity:** **0 Critical · 0 High · 2 Medium · 1 Low.**  
**Scope:** Adversarial document/security/distributed-systems review, not a deployed application vulnerability assessment, test execution, implementation ticket approval, provider-privacy approval, or authorization to send candidate content.

## 1. Materials, source precedence, and inspected repository

1. `ROUNDSET_PHASE4_ARCHITECTURE_v0.6_REAUDIT_CANDIDATE.md` (361 physical lines), authoritative candidate, cited as **Architecture** by exact line number.
2. `ROUNDSET_PHASE4_v0.6_EXTERNAL_AUDIT_FINDINGS_DISPOSITION.md` (52 lines), claim ledger requiring independent verification.
3. `ROUNDSET_PHASE4_v0.5_INDEPENDENT_REAUDIT_REPORT(1).md` (136 lines), original R5 baseline.
4. `ROUNDSET_PHASE4_v0.6_EXTERNAL_REAUDIT_PROMPT.md` (21 lines), instructions; `ROUNDSET_PHASE4_v0.6_PACK_README.md` (7 lines), packaging notes.
5. Connected GitHub repository `silent-knight19/Roundset`, **main at `5c6d1191ed4f8c29131c027314929064fd411737`**, inspected in this review, including:
   - `docs/ENGINEERING_RESEARCH_AND_ADRS.md`, ADR-017/019/021/022/025/026/027;
   - `docs/API_AND_DATA_CONTRACTS.md` (especially quota period, usage and state-machine contracts);
   - `docs/phase2/P2_AUTH_API_CONTRACTS_v1.md`, canonical `auth.v1`;
   - `docs/ADR/ADR-028-auth-identity-linking-and-sessions.md`;
   - `apps/api/src/routes/index.ts` and `docs/IMPLEMENTATION_TRACKER.md`;
   - `apps/api/src/modules/identity/models/index-manager.ts` for visible identity persistence progress.

**Repository evidence boundary:** The inspected router includes health/readiness and **conditional mounting of the auth router**, unlike the older health-only baseline. There is **no Phase 4 interview router in this inspected file**. The implementation tracker still marks P2-AUTH-01, P3 and P4 tasks unchecked; some flags lag actual Phase 2 repository work. It is not evidence that P2 transactional write fencing, P3 shared-ClientSession quota methods, P4, live 15-minute inference, or provider privacy approval are complete. The v0.6 candidate accurately states those as pending gates. No CI suite, Atlas replica-set concurrency test, live Qwen call, user-content provider egress, code edit or PR was performed in this review.

Useful primary documents:
- [Repository pinned to inspected HEAD](https://github.com/silent-knight19/Roundset/tree/5c6d1191ed4f8c29131c027314929064fd411737)
- [Current router pinned to HEAD](https://github.com/silent-knight19/Roundset/blob/5c6d1191ed4f8c29131c027314929064fd411737/apps/api/src/routes/index.ts)
- [ADR research](https://github.com/silent-knight19/Roundset/blob/5c6d1191ed4f8c29131c027314929064fd411737/docs/ENGINEERING_RESEARCH_AND_ADRS.md)
- [P2 auth contract](https://github.com/silent-knight19/Roundset/blob/5c6d1191ed4f8c29131c027314929064fd411737/docs/phase2/P2_AUTH_API_CONTRACTS_v1.md)
- [Original API and quota contract](https://github.com/silent-knight19/Roundset/blob/5c6d1191ed4f8c29131c027314929064fd411737/docs/API_AND_DATA_CONTRACTS.md)

## 2. Targeted R5 finding closure matrix

| Prior finding | Disposition | Exact v0.6 evidence | Independent assessment and remaining qualification |
|---|---|---|---|
| **R5-H01** — scalar `trustedSensitivity` cannot enforce mixed-origin consent | **CLOSED in design** | Architecture **§3 L83; §4 L92–112, L123; §5 L138, L144; §12 L278; §13 L313** | Internal `GenerationIntent` now has server-reconstructed `dataClasses`, source parts and transitive summary ancestry; every class must be approved for **the selected provider** before a transaction records the permit, and every fallback/repair gets its own classification. SYNTHETIC is exclusive to registered fixtures. A caller-provided downgrade is rejected. The actual per-class consent policy and privacy setting proof remain **O-04/O-05**. A distinct source ownership issue is R6-M01, not an assertion that R5-H01 remained unfixed. |
| **R5-M01** — permit transaction did not write-fence interview generation claim | **CLOSED in design** | **§1 L51; §3 L75–80; §5 L138; §9 L215; §13 L313** | Admission explicitly performs a **matched `interviews` write** (e.g. `stateVersion` increment) in **one Mongo transaction** with guarded P2 user/session writes, provider-account budget CAS, attempt and permit. Abort/terminal/reclaim updates the same interview; a stale transaction must conflict or reject. It does not advance candidate `publicSequence`. Publication must read the advanced current version rather than an obsolete pre-permit version. P2 interface and real Mongo tests remain **O-08**. |
| **R5-M02** — synthetic spike may escape shared provider-account limits | **CLOSED in design** | **§1 L51; §5 L135–144; §12 L279; §13 L297; §14 L324–325; O-07 L344** | Every candidate, synthetic, repair and fallback attempt sharing an actual provider tenant uses **the same account-wide all-or-none budget CAS**. Synthetic has an *additional* spike subcap, not an alternative account budget. Different API keys do not create separate allowances. Synthetic may skip candidate P2 consent only for verified fixtures. Actual provider limits and Atlas capacity remain unverified **O-07**. |
| **R5-L01** — stale v0.4 headings | **CLOSED** | **§11 L248–250; §14 L323** | Live candidate version labels are v0.6. Historical references to older audits are appropriate and are not defects. |

**Conclusion on required R5 checks:** 4/4 corrected at the contractual level. None is marked as runtime-tested.

## 3. Previous R3/R4 regressions

| Original issue | v0.6 regression result | Evidence / qualification |
|---|---|---|
| R4-H01: nonexistent pre-Q1 interview deadline | **PASS in design** | **§4 L125–127; §8.2 L203**. PRE_START cutoff uses READY/reservation/lease/request times. `startedAt`/15-minute deadline begins with Q1/P3 atomic publication; slow/expired provider results are discarded. See month-boundary publication ambiguity **R6-M02** below. |
| R4-M01: overlapping eligible outage interval credit | **PASS in design** | **§7 L179–183, §13 L300–301**: global union of half-open intervals; CAS capped credit; no `now−recoveringSince` inference or automatic refund from one 429. O-02 must settle evidence eligibility and late post-terminal appeal. |
| R4-M02: returning owner stranded by active slot | **PASS, conditional on O-09** | **§8.1 L191–193; §10 L225; §11 L235** mandates zero-provider ACTIVE/RECOVERING overdue reconciliation and owner-safe existing-ID/action or retry create. No always-on cron claimed. |
| R4-M03: previously generated Q text elevated to rubric authority | **PASS in design** | **§6 L152–156**: only approved plan-slot/competency IDs in main rubric authoring, never raw previous Q or answers; follow-up rubric remains immutable. |
| R4-M04: consent withdrawal between authorization and physical send | **PASS as explicit tradeoff, O-05 open** | **§3 L75–78; §5 L138, L144**: one-use P2/claim-fenced durable permit, final best-effort consent check, cancellation, stale-publication rejection. Cannot atomically recall already-sent provider input; no false guarantee. |
| R3-H01: pause/reconcile race | **PASS in design** | **§7 L181–185, §10 L223–225**: shared resolver CAS credits *verified* pause first, recomputes deadline, then terminalizes. |
| R3-H02: create after P2 deletion/purge | **PASS in design, P2 integration pending** | **§3 L79–81; §8 L193**: real shared transactional user/session write fence in create+P3 reserve and restoring/publishing mutations. |
| R3-H03: FOLLOW_UP creates scored main topic | **PASS in design** | **§6 L156**: `CLARIFY/DEEPEN/CHALLENGE` only; transition is server-owned/unscored; new main rubric generated in isolated `QUESTION` path. |
| R3-M01: idempotency replay cached stale Q1 | **PASS in design** | **§8.2 L199–207; §11 L261**: immutable effect receipt, reauthorize and reproject current safe state. |
| R3-M02: global provider policy change | **O-12 external gate** | **§3 L82; §15 L349**: admission quiesce/drain before global policy activation, not an invented P2 global lock. |
| R3-M03: durable generation intent recovery | **PASS in design** | **§9 L211–217; §10 L225**: explicit bounded `/advance` dispatch, zero-provider `/reconcile`; no permanently cached 202. |

**No regression in stack/ADR commitments:** `qwen/qwen3.8-27b` Groq primary; `@cf/qwen/qwen3.8-27b` Cloudflare OFF pending proof; Express 5/TypeScript/Node 22/MongoDB Atlas Free; memory-only Bearer on P4; P2 refresh CSRF; P3 credit ownership; P5/P6/P7 separation; no Redis or paid worker.

## 4. New, severity-ranked findings

### R6-M01 — Provenance classification does not explicitly authorize ownership of each referenced source

**Severity: MEDIUM (security specification completeness; conditional on a cross-scope assembler lookup).** **Architecture §3 L74–75 and L83; §4 L94–110, L123; §6 L156.**

- **Invariant:** An authorized user's interview may send only that user's currently authorized source data or explicitly public/server-owned context. Correct data-class consent is necessary but insufficient to authorize using another user's private response or summary.
- **Concrete reproducible scenario:** Accounts A and B each have `USER_TRANSCRIPT` consent for Groq. Both have a persisted `ContextSummary`. A's FOLLOW_UP assembler inadvertently resolves a globally cached summary belonging to B (e.g. keys the summary lookup only by `planSlotId`, not `(userId, interviewId, summaryId)`). The source descriptor/ancestor graph is internally complete and classifies the payload as `USER_TRANSCRIPT`. The admission transaction fences **A**'s P2 session and interview claim; the all-of class check passes, because it is not a *source owner* check. B's words can consequently be transmitted within A's authorized request if the assembler is implemented without the missing source-scope rule. No unauthenticated client controls `sourceRef` under the proposed trusted assembler, so **this is a specification omission and testable integration bug scenario, not a demonstrated attacker exploit**.
- **Why existing guards are not a proof:** `SourceDescriptor.ref` is server-controlled; `SourceDescriptor` has `kind`, `inheritedClasses`, `ancestorRefs`, but no explicit *current owner/allowed source scope* invariant. The documented P2 fence checks the interview principal; it does not expressly require verifying that each `sourceRef` resolves to content owned by that principal and interview or from an approved shared source.
- **Minimal ₹0 fix:** Freeze a source-resolution rule: every real-data root must be resolved under current `(userId, interviewId)` ownership and feature authorization; derivative nodes inherit the owner/scope and must be rejected if ancestor scope conflicts. Provider-input assembly must reject a foreign source before creating a permit. Public/server templates and registered synthetic fixtures have explicit separately validated origins. Use existing Mongo owner queries and trusted assembler; no extra service, persistent personal-text hashes or new paid resource.
- **Deterministic negative test:** Store B's unique transcript/summary under same normalized slot label as A. Force A's assembler to reference B's valid `sourceRef`/ancestry while class+provider consent passes. Assert `AI_PRIVACY_INELIGIBLE` or an internal source-ownership rejection, **zero committed attempt, zero account budget reservation, zero provider send**. Verify correct A-owned transcript and an allowed public fixture are accepted, and that same-owner but different-interview references follow explicit policy.
- **Required gate:** Source ownership invariant in AI-03/AI-01 assembler contract before real candidate inference. Do not call R5-H01 unresolved: its *class-closure* correction is sound.

### R6-M02 — Credit-period cutoff uses a transaction-chosen 'publicationTime' without defining a commit-across-month boundary

**Severity: MEDIUM (correctness, narrow month-end transaction window).** **Architecture §0 L22–23; §4 L125–127; §8.1 L193; §8.2 L203, L207.**

- **Invariant:** A Free session is charged to the calendar period in which its valid Q1 **durably begins**, not a stale READY reservation period after an expired cutoff. The Q1/event/P3 commit must remain one atomic logical outcome.
- **Deterministic interleaving:** READY and reservation expire at `00:00:00.000` Asia/Kolkata. At `23:59:59.990`, Q1 is ready, the START transaction verifies its time guards, chooses `publicationTime=23:59:59.990` and stages Q1+P3 commit. Test harness delays `commitTransaction` until `00:00:00.050`. All writes may commit after the cutoff, because the earlier application clock comparison does **not** automatically re-evaluate at the database's commit point. The stored `startedAt` and old-period reservation then portray a Q1 start in the previous month even though the durable Q1 could only become visible after midnight. The candidate calls `publicationTime` the authoritative publication-time server instant but does not distinguish *transaction guard time* from *durable commit completion*. MongoDB cannot guarantee that reading the wall clock earlier in a transaction enforces an absolute commit-time deadline by itself.
- **Important qualification:** This is a **contract-boundary ambiguity**, not an assertion that MongoDB transacts nonatomically or that a user can reliably exploit it. The owner could explicitly adopt an *application-decision timestamp* definition of START rather than a *durable-visibility timestamp*; that choice should be documented and tested against the Free monthly wording rather than assumed. Exact commit-time cutoff is not free to guarantee merely by choosing a timestamp earlier in the transaction.
- **Minimal ₹0 fix:** Freeze one consistent definition of `startedAt`, period ownership and START linearization. Recommended for the stated 'durably published' rule: fail closed at month/READY boundaries with a **verified conservative pre-commit safety window and bounded transaction/commit deadline** (limits justified by the actual free Atlas environment); reject or defer Q1 publication when a cutoff cannot be met with sufficient margin. Reconcile unknown commits by immutable Q1/P3/receipt IDs. If the product instead explicitly anchors to the guarded application timestamp even when durable commit follows later, obtain owner signoff of that boundary semantics and ensure no period arbitrage or duplicate benefit. **Do not** claim a last-millisecond application-time check proves a commit-time cutoff. No new service, clock source or billing system is required.
- **Deterministic negative test:** Fault-inject a pause just before `commitTransaction` across both READY expiry and Asia/Kolkata month rollover; compare transaction guard time, durable completion, recorded start time and period debit. Assert the owner-approved timestamp rule with a single Q1 and P3 outcome; fail-closed policy must never publish an old-period Q1 when the defined cutoff has passed. Repeat with ambiguous commit ACK and concurrent release/abort; no duplicate credit or Q1.
- **Required gate:** Publish/start/period-edge contract addendum before freezing Q1/P3 transactional implementation; do not alter Free credit entitlement or invent TTL numbers on behalf of the owner.

### R6-L01 — Ticket prerequisite for the interview-claim CAS is not clearly staged

**Severity: LOW (implementation-plan clarity, not a proven runtime deadlock).** **Architecture §14 L323–329; §3 L75–80; §5 L135–138.**

- **Invariant:** Each source implementation ticket must be executable with accepted interfaces and acyclic implementation dependencies; no coding agent should infer permission to modify P2 or skip the permit fence because another phase has not yet implemented it.
- **Possible circular interpretation:** `P4-AI-01` lists an **accepted interview-claim CAS**, but `P4-INT-01` owns the interviews/claim persistence and is itself conditioned on AI-01/AI-03 relevant schemas. An implementer treating these as **completed implementations** rather than **approved contract shapes** can block both tasks. The document explicitly allows AI-01 mock/synthetic subsets earlier; thus **no unavoidable dependency cycle has been proven**.
- **Minimal ₹0 correction:** State the intended stages explicitly: (a) freeze interface shapes in DESIGN; (b) AI-01 budget + synthetic/mock adapter can be delivered without candidate P2/claim integration, under the shared-account budget; (c) INT-01 implements the interview claim CAS using accepted P2/P3 and frozen AI schemas; (d) AI-01 candidate-private dispatch integration is enabled only after INT-01 claim CAS and O-05/O-04 gates. Coding tickets stay atomic with clear ownership and no unapproved extra service.
- **Negative acceptance check:** Draw a dependency DAG for source implementation stages and verify topological ordering; compile mock-only gateway with no real interview, then demonstrate integration ticket requires the accepted claim interface. This is **not** a live concurrency proof.

## 5. Cross-contract conclusions (not new defects)

1. **R5-H01 all-of class closure is sound for the defined root classes.** The trusted assembler's `messages.parts` manifest, recursive `DERIVED_SUMMARY` lineage, `SYNTHETIC` fixture exclusivity and permit-bound canonical set close the exact scalar-enum counterexample. If a later feature reuses model-generated question/follow-up text as prompt input, the implementation must treat it as lower-trust derived material with complete original-class lineage; **the current v1 only explicitly allows finalized answers and source-tagged summaries** in FOLLOW_UP, so hypothetical future reuse is an extension contract, not evidence that this v0.6 fix fails. Add a derived-model-output type when that feature is approved, or exclude such reuse.
2. **Real write-conflict semantics are correctly specified.** Matched conditional `interviews` write in the same transaction as P2 and account CAS addresses abort/admission ordering. On MongoDB snapshot reads, a read-only check would not have been adequate. The new stateVersion inc must not advance publicSequence; the publication transaction must read the current stateVersion after a permit. Distinguish `UnknownTransactionCommitResult` from proven rollback. Official docs: https://www.mongodb.com/docs/manual/core/transactions-production-consideration/ and https://www.mongodb.com/docs/manual/core/transactions-in-applications/.
3. **Provider budgets are unified in design.** Per-account all-or-none reserve across RPM, RPD, TPM, TPD, concurrency and applicable neurons, plus rolling 60s conservative logic and original-window late settlement, is a defensible ₹0 approach. Exact provider rate-window policy, free-account caps, hot-document p95/throughput and daily neurons still require synthetic/account-backed tests. No guarantee of zero 429 can be claimed.
4. **P2 serialization is still an integration gate.** The contract forbids a no-op or read-only P2 fence and forbids holding external model HTTP open in a Mongo transaction. Actual accepted P2 user/session guarded write primitive is not verified available in the repo.
5. **Pre-start / recovery and refunds:** START uses no startedAt/effective deadline until Q1; verified outage union is accounted once before terminalization. The user is not refunded for mere inactivity. O-02 must specify evidence finality and post-terminal appeal because immutable terminal state cannot spontaneously reopen when late telemetry arrives.
6. **Global O-12 versus user O-05:** A P2 user/session mutation does not serialize global provider-policy revisions. Quiesce/drain/cancel admissions is a proposed rollout protocol requiring real multi-process/operator validation; per-user final-check→physical-send race is acknowledged under O-05, not an imaginary zero-width window.
7. **Account-bound source ownership is the extra invariant worth freezing**; consent classification and ownership serve different security purposes. R6-M01 requires no new storage platform.

## 6. ADR and ₹0 compliance matrix

| Constraint/authority | Result | Evidence qualification |
|---|---|---|
| ADR-017 Node/Express/TS/Mongo monolith | PASS | No proposed microservice. |
| ADR-019 Groq selected Qwen; Cloudflare same Qwen conditional OFF | PASS | Free-account performance and privacy unverified. |
| ADR-020 P5 browser Kokoro/VAD/STT | PASS | Phase 4 does not claim voice integration or new paid STT. |
| ADR-021 durable state, server time, Mongo events | PASS IN DESIGN / R6-M02 | PRE_START/ACTIVE cutoffs and outage accounting are coherent; clarify transaction commit-time month boundary. |
| ADR-022 P3 atomic period credit | PASS IN DESIGN / R6-M02 | Single Q1/event/P3 transaction specified; shared ClientSession API and period boundary signoff pending. |
| ADR-023 same-origin proxy | PASS IN DESIGN | Trusted ingress and origin/cookie deployments unverified. |
| ADR-025 strict Free/premium DTO segregation | PASS IN DESIGN | Rubrics/internal events excluded; real API tests pending. |
| ADR-026 no Redis/paid worker | PASS | Durable intent, zero-provider reconcile, explicit advancement. |
| ADR-027/ADR-028 P2 Bearer and refresh CSRF | PASS IN DESIGN | Current P2 write fence and deployed proxy not verified. |
| Candidate data / per-provider privacy | CONDITIONAL | All-of classes correct; source-owner invariant R6-M01 and O-04/O-05 gate. |
| Global/provider account budget | PASS IN DESIGN | Shared synthetic+candidate accounting; O-07 real-account capacity proof. |
| ₹0 operations | PRESERVED | No paid components introduced; capacity and model quality unproven. |

## 7. Mandatory tests at applicable implementation gates (NOT RUN)

1. All-of transcript+document denial on either denied category, transitive summary lineage, synthetic fixture exclusivity, provider-specific fallback and new permit per repair; no private payload/manifest content in logs.
2. **New R6-M01** cross-principal and same-principal/different-interview `sourceRef` resolution; deny foreign transcript before account-budget/permit, including a globally cache-key-colliding summary.
3. **New R6-M02** START pre-commit cutoff barrier at Asia/Kolkata month rollover and READY expiry, with ambiguous commit result and concurrent abort; precisely one logical Q1/credit outcome under chosen timestamp policy.
4. P2 user+session and interview version write conflict versus abort/reclaim/deletion/consent withdrawal; no successful stale permit; publisher re-reads post-permit `stateVersion`; no `publicSequence` increment on internal permit.
5. Synthetic versus candidate final provider-account slot race across two process sessions; both share account global caps; extra spike cap only tightens.
6. Slow Q1/PLAN before READY expiry: timer begins only at Q1 atomic publication. Expired/rolled-over Q1 discarded; no early clock debit or wrong monthly P3 movement.
7. Overlapping, duplicate, late and out-of-order verified outage interval evidence across incidents and concurrent resolver requests, no unverified browser-inactivity credit.
8. New browser without remembered interviewId after overdue ACTIVE/RECOVERING on sleeping free host: mandatory O-09 owner-discovery/reconcile or owned actionable reference; no new AI traffic from GET/reconcile.
9. Same-key START/advance replay after crash and lease expiry, stale terminal/suspended/deleted resource, unknown Mongo commit; no duplicate P3/Q1; 202 never cached as permanent response.
10. Provider schema and semantic guards for lower-trust FOLLOW_UP, unchanged parent rubric, isolated QUESTION rubric, dedup without prior generated raw Q in authoring prompts; no scoring from P4.
11. O-05 revocation before permit, after permit and after send; stale publication denied, permitted physical-send residual behavior documented; O-12 global rollout admission shutdown/drain on all API processes.
12. Synthetic-only full-session real Qwen test with actual account limits and logged sanitized metadata, real Atlas Free transaction contention, owner-approved privacy dashboard proof; **none has been run in this audit**.

## 8. Separate external owner / provider / integration gates

| Gate | Dependency (NOT a newly demonstrated defect) |
|---|---|
| **O-01** | Accepted P3 `reserve/commit/release/refund` with shared Mongo ClientSession and uncertain-commit recovery. |
| **O-02** | Actual verified-outage evidence standard, pause/grace, refund finality and coverage thresholds. |
| **O-03** | Selected Groq Qwen model JSON/reasoning compatibility, Preview/rate headers, full 15-minute quality and costs. |
| **O-04** | Real Groq/Cloudflare retention/consent dashboard and no-paid verification; Cloudflare fallback OFF. |
| **O-05** | All-of class-specific privacy/consent, source ownership invariant, data retention/export/purge and permitted post-admission withdrawal semantics. |
| **O-06** | Owner HTTP/DTO and legacy-route migration freeze, future P7/P6/P8 endpoint boundary. |
| **O-07** | Real shared provider-account limits, shared synthetic admission, rolling-window controls and Atlas Free contention. |
| **O-08** | Accepted P2 `fenceAuthorizedMutation` real write/CAS, integrated interview CAS, origin/edge/CORS and JWT renewal. |
| **O-09** | Explicit one-nonterminal-interview policy or alternate concurrent-session policy. |
| **O-10** | Preflight/READY TTL, bounded Q1/PLAN work, pre-publication abort and month-edge start criterion (R6-M02). |
| **O-11** | Sleeping-host lazy reconciliation and support adjudication. |
| **O-12** | Actual quiesce/drain/cancel policy activation across relevant deployment instances. |

## 9. Final approval verdict and eligible subsets

**APPROVE WITH CONDITIONS — for the overall v0.6 architecture DESIGN.** All R5-H01/M01/M02/L01 gaps are closed at the specification level, and no independent new Critical/High architecture blocker was established. The above two Medium clarifications concern **source-level principal ownership** and the **last-millisecond month/READY publication boundary**; address both in the owner-reviewed contract addendum before allowing those affected private-data and Q1/credit implementations. R6-L01 should be cleaned up when issuing actual implementation tickets. No wholesale v0.7 rewrite, different model, extra provider, paid queue, cron or Redis is warranted.

**Eligible for owner contract-freeze consideration once policy choices are recorded:** provider-neutral gateway interfaces and error taxonomy, server-derived all-of class/fixture rules (subject to R6-M01), shared account-budget design, guarded P2+interview+budget permit transaction, PRE_START/POST_START gating, durable generation and replay, outage union, isolated rubric authoring, and candidate-safe DTO patterns. A freeze is a separate explicit owner action.

**Still blocked:** Real user/private-data egress until R6-M01, accepted P2/P3 and O-04/O-05; Q1/P3 transactional implementation until R6-M02 period/time criterion and O-01/O-10; any actual 15-minute/₹0 feasibility claim until O-03/O-07 and synthetic tests. `P4-AI-01` pure mocks/contracts and the tightly gated synthetic-only budget path can be separately scoped after their own approval, but **this report is not authorization**.

**No application code written. No user records accessed. No Groq or Cloudflare request sent. No production exploit demonstrated. No automated Phase 4 tests executed.**
