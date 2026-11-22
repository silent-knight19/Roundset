# AI Interviewer — API, Database, State and Security Contracts

**Version:** 1.0 · **Status:** Implementation baseline, to be refined with versioned ADRs after tests. No API endpoints described here are claimed already implemented.

## 1. API conventions

- Base `/api/v1`; HTTPS in deployment; JSON request/response; `Content-Type: application/json` except authorized upload and signed raw webhook endpoints.
- Standard response `{ data, meta?: { requestId } }`; error `{ error: { code, message, requestId, details? } }`, never stack trace or secrets.
- Inputs checked with shared Zod schemas; never trust frontend plan, owner, role, score, `durationSec`, integrity severity or timestamps.
- Authentication: short-lived access token and rotating secure refresh session; derive principal from verified credentials; `userId` in URL must match principal unless privileged admin authorization is explicitly checked.
- Idempotency-Key required for session creation, quota changes, final answer submission, grade scheduling and billing changes. Stable responses on retry.
- Every mutating endpoint applies origin/CSRF defense consistent with cookie security; all endpoints apply resource ownership.
- Public health endpoints expose minimal data; readiness internal/admin must not expose environment secrets.
- All timestamps UTC ISO-8601; milliseconds for durations; Indian calendar-month Free reset calculated in explicit project policy timezone **Asia/Kolkata** (backend stores UTC boundaries); paid reset on subscription renewal anchor.
- File upload max and rate limits set by configuration (defaults below are candidate limits); reject oversize with consistent `PAYLOAD_TOO_LARGE`.

## 2. Endpoint map (planned)

| Endpoint | Method | Auth | Output / notes |
|---|---|---|---|
| `/health/live` | GET | Public | `{ status:'ok', build }`, never credentials |
| `/health/ready` | GET | Public-minimal or admin | `{ ready:boolean }`, no sensitive connection strings |
| `/auth/register` | POST | Public/allowlist | Email+password creates unverified identity, starts email challenge |
| `/auth/verify-email` | POST | Challenge | OTP proof, verify email, activate app account |
| `/auth/login` | POST | Public | Email/password → app session |
| `/auth/google/exchange` | POST | Firebase ID token | Server verifies Firebase ID token; maps/provisions identity; app session |
| `/auth/otp/resend` | POST | Challenge/limited | Rotate challenge, throttle; no old OTP reuse |
| `/auth/password/forgot` | POST | Public | Uniform success message to prevent enumeration |
| `/auth/password/reset` | POST | Challenge | Verify reset token, set new Argon2id hash, revoke sessions |
| `/auth/password/change` | POST | Auth | Current password/reauth proof required |
| `/auth/refresh` | POST | Refresh cookie | Rotate session, issue access; replay revokes family |
| `/auth/logout` | POST | Auth/refresh | Revoke this session and clear cookie |
| `/auth/logout-all` | POST | Auth | Revoke all user sessions |
| `/auth/identities/link-google` | POST | Auth+reauth | Verified identity linking, no email-only auto-merge |
| `/auth/phone/start`, `/auth/phone/verify` | POST | Public/limited | Provider-neutral SMS OTP; dev mock vs real carefully differentiated |
| `/me` | GET/PATCH | Auth | Self profile and allowed preferences only |
| `/me/data-export` | POST/GET | Auth | Personal-data export independent of premium paywall |
| `/me/account` | DELETE | Auth+reauth | Controlled deletion/anonymization; reversible stages per retention policy |
| `/plans` | GET | Public | Free, ₹250/10, ₹500/25, ₹1,000/50; sandbox flags |
| `/entitlements/me` | GET | Auth | Plan, feature flags, credit period, used/reserved/available, VIP expiry |
| `/interviews/preview` | POST | Auth | Normalized editable plan preview, not actual questions |
| `/interviews` | POST | Auth+quota | Reserve credit; create DRAFT/PREFLIGHT session, idempotent |
| `/interviews/:id/ready` | POST | Owner | Preflight device + permissions; no new credit |
| `/interviews/:id/start` | POST | Owner | Commit credit at first question, server timestamp/deadline |
| `/interviews/:id` | GET | Owner/admin | State, plan, remaining time, last checkpoint; no premium details to Free |
| `/interviews/:id/turns` | POST | Owner | Finalized transcript answer with question/turn IDs, idempotent |
| `/interviews/:id/next` | POST | Owner | AI next follow-up generated for controlled active state |
| `/interviews/:id/code` | PUT | Owner | Save versioned code/snapshot with revision conditional |
| `/interviews/:id/integrity-events` | POST | Owner/device token | Client observations only; backend groups/escalates |
| `/interviews/:id/events` | GET | Owner/admin | Reconnect-safe event stream / cursor; privacy filtering |
| `/interviews/:id/complete` | POST | Owner/server | Finalize if time/state permitted, trigger evaluation |
| `/interviews/:id/cancel` | POST | Owner | Disposition and appropriate reserve release/refund rules |
| `/interviews` | GET | Owner | Paged own history; truncated free result summary |
| `/interviews/:id/result` | GET | Owner | Completed aggregate /10 only for Free; status elsewhere |
| `/interviews/:id/report` | GET | Owner + `detailed_report` | Full report DTO, not offered to Free |
| `/interviews/:id/report.pdf` | GET | Owner + `report_pdf` | Premium annotated PDF; secure authorization and no-store cache |
| `/coaching/weak-topics` | GET | Owner + premium | Advanced trend analysis |
| `/coaching/answer-retry` | POST | Owner + premium | Bounded AI coach with usage checks |
| `/personalization/resume` | POST | Owner + premium | Extract safe PDF/DOCX text, user edits skills |
| `/personalization/jd` | POST | Owner + premium | JD info and topic-gap proposal |
| `/personalization/repository` | POST | Owner + premium | Public GitHub bounded scan (not code execution) |
| `/billing/sandbox/checkout` | POST | Owner | Test-provider only; no real checkout |
| `/billing/subscription` | GET | Owner | Subscription/trial and test payment records |
| `/billing/webhooks/:provider` | POST | Signed raw body | Verify and idempotently process provider event |
| `/invites/redeem` | POST | Auth+verified invited email | Redeem cryptographically strong one-time link |
| `/admin/users` | GET | Admin | Paginated searchable user directory, operational metadata |
| `/admin/users/:id` | GET | Admin | User status/plan/usage/interviews; sensitive payload guarded |
| `/admin/users/:id/quota-adjustments` | POST | Admin+reason | Grant/revoke/add credits atomically, audit |
| `/admin/users/:id/entitlement` | PUT | Admin+reason | Set plan/VIP expiry; no fake payment record |
| `/admin/users/:id/status` | PATCH | Admin+reason | Suspend/reactivate, audit |
| `/admin/users/:id/data-delete` | POST | Admin+reason+step-up | Controlled deletion workflow |
| `/admin/invitations` | GET/POST | Admin | Issue/list email-bound expiring VIP invitations |
| `/admin/invitations/:id/revoke` | POST | Admin+reason | Revoke unredeemed/redeemed VIP under policy |
| `/admin/usage` | GET | Admin | Aggregate provider request/token/neuron/latency/429 counts |
| `/admin/audit` | GET | Admin | Filterable immutable audit history |
| `/admin/config` | GET/PATCH | Admin+reason | Safe bounded feature flags/plan settings |

**Naming note:** API names are implementation design defaults, not mandated by previous brainstorming. They can be refined only with explicit contracts/tests, without changing entitlement semantics.

## 3. Example JSON contracts

**Create interview (request):**

```json
{
  "mode": "ASSESSMENT",
  "durationMinutes": 15,
  "track": "TECHNICAL",
  "role": "Backend Engineer",
  "difficultyMode": "ADAPTIVE",
  "topics": [{"name":"Java Concurrency","weightPct":60},{"name":"DBMS","weightPct":40}],
  "codingSharePct": 0
}
```

Validate topics weight sum exactly 100; free always `durationMinutes=15` regardless of malicious client input. When Premium add resume/JD/repo references bound to the same owner; avoid sending file contents directly in start request.

**Start interview (response):**

```json
{
  "data": {
    "interviewId": "int_opaque_id",
    "status": "ACTIVE",
    "startedAt": "2026-11-22T11:00:00.000Z",
    "deadlineAt": "2026-11-22T11:15:00.000Z",
    "question": {"questionId":"q_opaque_id", "text":"Explain ...", "turnId":"turn_opaque_id"},
    "sequence": 1
  }
}
```

Time shown is **illustrative**, not a real user session. For recoverable server-side timeout return `RECOVERING`, not silently reset deadline.

**Free overall-result response:**

```json
{
  "data": {
    "interviewId": "int_opaque_id",
    "status": "COMPLETED",
    "overallScore": 7.8,
    "scaleMax": 10,
    "premiumDetailsAvailable": false
  }
}
```

No `questionScores`, `rubrics`, `transcript`, `modelAnswer`, `improvementAdvice`, `privateCodeAnalysis` or raw report hidden anywhere in Free response. For `TERMINATED_INTEGRITY`, `overallScore` must not be presented as a normal completed rating.

**Upgrade gating:** `GET /interviews/:id/report` for Free returns status `403` with error code `PREMIUM_REQUIRED`, without leaking report content. `GET /me/data-export` remains available.

## 4. Core MongoDB collections / indexes

| Collection | Minimum fields | Unique / critical index |
|---|---|---|
| `users` | `_id, emailNormalized, emailVerified, displayName, role, accountStatus, createdAt` | unique emailNormalized (sparse where appropriate) |
| `authIdentities` | `userId, provider, subject, passwordHash?` | unique provider+subject; provider+userId |
| `sessions` | `userId, familyId, refreshHash, status, expiresAt, deviceInfo, rotatedAt` | unique refreshHash; TTL expiresAt |
| `verificationChallenges` | `userId?, emailHash, purpose, otpHash, attempts, expiresAt, consumedAt` | TTL expiresAt; lookup purpose+emailHash |
| `interviews` | `userId, planSnapshot, config, status, startedAt, deadlineAt, lastSequence, version, reservationId` | userId+createdAt; status+deadlineAt |
| `interviewEvents` | `interviewId, sequence, eventType, payload, idempotencyKey, createdAt` | unique interviewId+sequence, unique interviewId+idempotencyKey |
| `questions` | `interviewId, questionId, topic, type, text, rubric, difficulty` | unique interviewId+questionId |
| `responses` | `interviewId, turnId, questionId, answerText, submittedAt, source, revision` | unique interviewId+turnId |
| `evaluations` | `interviewId, questionId, score, evidence, improvements, evaluatedAt, modelMeta` | unique interviewId+questionId+version |
| `usagePeriods` | `userId, periodKey, limit, reserved, consumed, adjustment, reservations[]` | unique userId+periodKey |
| `usageLedger` | `userId, periodKey, opId, kind, delta, actorId?, reason?, createdAt` | unique opId |
| `subscriptions` | `userId, planCode, status, billingAnchor, periodStart, periodEnd, source` | userId+periodEnd |
| `paymentEvents` | `provider, eventId, rawHash, verified, mappedState, processedAt` | unique provider+eventId |
| `invitations` | `emailNormalized, tokenHash, plan, expiresAt, redeemedBy?, revokedAt?` | unique tokenHash; TTL policy carefully applied |
| `integrityIncidents` | `interviewId, ruleId, incidentId, severity, startedAt, resolvedAt, evidenceSummary` | unique interviewId+incidentId |
| `adminAuditLogs` | `actorId, targetType, targetId, action, reason, requestId, changedFields, occurredAt` | occurredAt+actorId |
| `providerUsage` | `provider, model, purpose, correlationId, inTokens, outTokens, latencyMs, status, at` | unique correlationId+provider+attempt |
| `systemSettings` | `key, value, modifiedAt, modifiedBy` | unique key |

Do not store passwords in `users` profile, raw refresh tokens in MongoDB, or private media indefinitely. Enforce document size caps and retention rules.

## 5. Quota period / atomic update contract

**Period creation:** one stable period key per user and period. Free uses `YYYY-MM@Asia/Kolkata`. Paid uses subscription period ID from verified sandbox billing anchor. VIP still logs usage for global-capacity monitoring.

**Reservation invariant:** `consumed + reserved < limit + adjustment`, unless active VIP entitlement. Use a MongoDB **single-document conditional update** against `usagePeriods` to atomically reserve. For safety, create period document before increments and add unique op ID; concurrent races may fail with quota-exhausted, never double grant. Store bounded reservation mapping for rollback/deduplication.

**Commit:** reserve → commit when question begins (increments consumed/decrements reserved exactly once). **Release:** preflight failed/aborted before first question. **Refund:** verified server error after commit credits consumed decremented exactly once with logged reason; never refund integrity termination. **Admin adjustment:** logged reason, actor, delta, cannot tamper billing event. **Reconcile:** repair missing ledger from authoritative period and session record; never count an operation twice.

**Race tests required:** 100 simultaneous start attempts for Free; concurrent admin grant + start; same idempotency key replay; crash before/after reserve; period reset at month boundary; fraud attempt via alternate devices; VIP expired during a session; system outage after credit committed.

## 6. Interview state transition table

| From | Event | To | Guard / effect |
|---|---|---|---|
| `DRAFT` | Configure | `PREFLIGHT` | Auth + plan valid, reserve quota only when requesting session |
| `PREFLIGHT` | Device checks valid / backend ready | `READY` | No countdown, no commit |
| `READY` | First question dispatched | `ACTIVE` | Atomically commit quota, server sets start/deadline |
| `ACTIVE` | Answer finalized | `ACTIVE` | Sequence++, save turn, stage evaluation once |
| `ACTIVE` | Recoverable provider/network failure | `RECOVERING` | Persist state, bounded retry/pause policy |
| `RECOVERING` | Valid authenticated reconnection | `ACTIVE` | Verify deadline, no new credit, restore transcript/integrity |
| `ACTIVE` / `RECOVERING` | Normal end | `COMPLETED` | Stop timer, finalize and score after evaluation completes |
| `ACTIVE` / `RECOVERING` | Integrity threshold exceeded | `TERMINATED_INTEGRITY` | Permanent close, consume credit, 15-minute cooldown |
| `PREFLIGHT` / `READY` | Pre-start abort | `ABORTED_PREFLIGHT` | Release reservation, no score |
| `ACTIVE` / `RECOVERING` | Platform-failure abort | `ABORTED_SYSTEM` | Refund once under verified system-failure policy |
| `ACTIVE` / `RECOVERING` | Time expired / abandoned | `EXPIRED` | Document policy distinguishes normal timing completion vs abandonment |

No backwards transition from terminal states. Backend event handler must reject incorrect expected state/version, duplicate turn IDs, unauthorized owner and timestamps fabricated by client. Clock pause for mic/camera recovery is backend-managed, capped, and not silently reset by reconnect.

## 7. AI output schema v1 (Zod-validated)

**Question proposal:** `questionId`, `type:TECHNICAL|BEHAVIORAL|CODING`, `topic`, `difficulty`, `text`, `expectedConcepts[]`, `scoringRubric[{criterion,maxPoints,description}]`; sum `maxPoints = 10.0`. Never send expected concepts/rubric in Assessment UI.

**Follow-up proposal:** `text`, `purpose:CLARIFY|DEEPEN|CHALLENGE|TRANSITION`, `relatedQuestionId`, `nextStateHint` (advisory only). Backend validates duration/turn context and decides actual transition.

**Evaluation:** `questionId`, `score:0..10 step .1`, `correctPoints[]`, `incorrectOrMissing[]`, `evidenceQuotes[]` (from actual answer), `improvements[]`, `modelAnswer?`, `confidence?`, `modelMeta`; no arbitrary plagiarism/guilt field. Integrity events stored separately.

**Privacy:** pipeline may use rubric + answer only; candidate-provided instructions in answer or README must not modify grading rubric or authorization.

## 8. Permissions matrix

| Operation | Free candidate | Paid candidate | VIP candidate | Admin |
|---|---|---|---|---|
| View own completed overall score | Yes | Yes | Yes | Admin operational support scope only |
| View own detailed report | No | Yes | Yes | Justified, audited support access only |
| Start Free-length interview within quota | Yes | Yes | Yes | Admin acting as candidate under own account |
| Upload JD/resume for tailored session | No | Yes | Yes | Own candidate context only |
| Query user directory | No | No | No | Yes |
| Add another user's credits | No | No | No | Yes + reason + audit |
| Grant VIP | No | No | No | Yes + reason + audit |
| View password/OTP/session secret | Never | Never | Never | **Never** |
| Export own personal data | Yes | Yes | Yes | Admin's own account; support deletion only per policy |

## 9. Error codes

`AUTH_REQUIRED`, `EMAIL_UNVERIFIED`, `OTP_EXPIRED`, `OTP_INVALID`, `OTP_RATE_LIMITED`, `ACCOUNT_SUSPENDED`, `FORBIDDEN`, `PREMIUM_REQUIRED`, `QUOTA_EXHAUSTED`, `CAPACITY_UNAVAILABLE`, `INTERVIEW_COOLDOWN_ACTIVE`, `INTERVIEW_STATE_CONFLICT`, `INTERVIEW_EXPIRED`, `INTEGRITY_TERMINATED`, `AI_PROVIDER_UNAVAILABLE`, `AI_SCHEMA_INVALID`, `REPLAY_CONFLICT`, `BILLING_SANDBOX_ONLY`, `INVITATION_INVALID`, `INVITATION_EXPIRED`, `INVALID_INPUT`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`.

Clients must distinguish quota denial (upgrade/renewal), global provider capacity denial (retry later), system recovery (resume), integrity termination (cooldown), and premium report denial (paywall). Never turn a provider failure into an anti-cheat incident.

## 10. Contract-change policy

Changes that modify previously agreed user-visible behavior require explicit decision record and an updated API test. Routine path names/payload refinements may change during implementation, with migration/version docs. This specification describes **what to build**, not proof of already-built endpoints.
