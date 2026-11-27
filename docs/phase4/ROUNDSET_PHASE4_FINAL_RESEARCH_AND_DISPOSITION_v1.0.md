# Roundset Phase 4 — Final Independent Technical Research and R6 Disposition
**Date:** 2026-11-23  
**Evidence basis:** v0.6 final external audit, full v0.6 architecture and original R3–R5 audits, current Roundset `main@5c6d1191ed4f8c29131c027314929064fd411737`, official provider/DB references below. **No live account access or runtime test was performed.**

## Final R6 disposition

| ID | Audit severity | Independent verdict | v1.0 disposition |
|---|---|---|---|
| R6-M01: owner/scope authorization of input | Medium | True contract omission, not observed data exposure | **CLOSED in design**: authoritative user+interview+record/version lookup and immutable same-interview derived ancestry before budget/permit; foreign and cross-interview deny |
| R6-M02: credit period versus commit boundary | Medium | True business timestamp ambiguity; exact wall-clock commit guarantee cannot be inferred from app precheck | **CLOSED by explicit policy**: single `startDecisionAt` business-effective timestamp inside short committed Q1/P3 transaction; period derived from that timestamp, 30-second pre-commit guard band for UX, no false claim of physical ACK/commit time equality |
| R6-L01: ticket order | Low | Editorial/implementation dependency issue | **CLOSED**: pure AI-01a schemas first; INT-01 owns claim CAS; AI-01c integrates candidate provider only after accepted P2/P3/privacy |

**Decision:** No further general document re-audit. Freeze architect technical baseline, authorize **mock-only AI-01a** as first source ticket. Code/security, real Atlas, synthetic provider and private egress each have their own proof gates.

## Technical cross-checks (official primary sources)

1. **MongoDB's multi-document transactions and write conflicts:** Transaction snapshot reads can be stale; a real update such as `findOneAndUpdate` is needed to conflict with concurrent status/owner changes. Source: https://www.mongodb.com/docs/manual/core/transactions-production-consideration/
2. **MongoDB commit uncertainty and bounded runtime:** Driver documents `TransientTransactionError` versus `UnknownTransactionCommitResult`; majority write concern and driver-recommended retry/reconciliation apply. A wall-clock timestamp sampled before calling commit is NOT proof of the physical visibility time. Sources: https://www.mongodb.com/docs/drivers/node/current/crud/transactions/ and https://www.mongodb.com/docs/manual/core/transactions/
3. **Groq selected model:** Official supported-model and changelog sources identify `qwen/qwen3.8-27b`. Verify account model visibility at runtime; never auto-substitute. Sources: https://console.groq.com/docs/models and https://console.groq.com/docs/changelog
4. **Groq free rate ceilings:** Official rate-limit page provides plan/model examples and says **actual organization limits must be read in the account console**. Header fields for requests are daily and tokens minute-based; these headers do not prove an exact universal rolling-window algorithm. Source: https://console.groq.com/docs/rate-limits
5. **Groq structured outputs:** `json_object` can produce valid JSON, but semantic correctness still needs Zod and business validation. JSON Schema strict support/configuration must be verified on the selected model/account. Source: https://console.groq.com/docs/structured-outputs
6. **Groq privacy:** Groq states inference content is not retained by default, but reliability/abuse exceptions may permit up to 30 days; **Zero Data Retention is an available console setting**, not evidence this project's account has it enabled. Operator must verify Data Controls and get candidate consent before private traffic. Source: https://console.groq.com/docs/your-data
7. **Cloudflare model/provider:** Official Workers AI lists `@cf/qwen/qwen3.8-27b`; pricing and free eligibility vary. Fallback remains OFF, not a hidden free replacement. Sources: https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/ and https://developers.cloudflare.com/workers-ai/platform/pricing/
8. **Atlas Free:** Official documentation lists Free cluster operational/storage limits; this does not establish transactional p95/throughput under Roundset's competing P2/P3 and budget CAS hot documents. Real dedicated replica-set tests remain required. Source: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/

## Why R6-M02 uses business-effective time rather than pretending to enforce exact commit wall clock

A MongoDB transaction can start and stage writes at `23:59:59.990` and be majority-acknowledged at `00:00:00.050`. The driver exposes transactional outcomes, not an application-friendly atomic predicate equivalent to “commit before the local-month cutoff.” `new Date()` sampled in transaction does not make it commit-time. A configurable guard band cannot rule out all stalls. **Therefore** the product selects a coherent event-time contract: on successful commit, the **business-effective** start and quota month equal the single server-sampled `startDecisionAt` persisted in Q1/event/P3 receipt. If the transaction never commits, no interview/credit exists. If ACK is delayed, reconcile stable receipt. Public UX must disclose that the recorded start may precede the HTTP acknowledgment under rare delays and that verified outage credit follows separate O-02 rules. An owner who instead requires literal physical commit-before-midnight must approve a different protocol, not mandate unattainable certainty from a pre-commit check. This is a defined and testable **policy choice**, not a technical proof of commit-time compliance.

## Evidence limits

- The final external v0.6 audit supplied 0 Critical, 0 High, 2 Medium and 1 Low. All are **closed in contract text**, **not tested in production**.
- Current repo still lacks a verified Phase 4 route and accepted P3/P2 shared mutation integrations; real account limits/retention and live session quality have not been checked by this action.
- All new implementation code must undergo PR-level review. No provider keys, Mongo credentials or candidates' personal information belong in artifacts or AI coding-agent prompts.
