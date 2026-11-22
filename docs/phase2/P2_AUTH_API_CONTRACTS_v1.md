# Roundset — Phase 2 Auth API / Persistence Contracts v1.2

**D3 documentation approval candidate — not implemented; not authorization to code until owner merges this documentation PR.** Baseline `main@36e9f590d297681987ded1a6028898c026686230`. Companion [`P2_DESIGN_01_AUTH_ARCHITECTURE.md`](P2_DESIGN_01_AUTH_ARCHITECTURE.md). Canonical contract ID `auth.v1` (derived from independently challenged v1.2 review drafts). Paths relative to `/api/v1`.

## 1. Conventions and auth boundary

- Request JSON must pass strict Zod validation, rejecting unknown properties on credential/role-affecting endpoints; overall Express JSON max 64 KiB, but smaller string lengths below. Response JSON envelope `{data:...,meta:{requestId}}`; errors `{error:{code,message,requestId}}`; **204 has no JSON body**.
- All auth, profile, export and session responses: `Cache-Control: no-store`; never cache authenticated API responses at Cloudflare; never return raw password hashes, OTPs, registration nonce, refresh/CSRF signing keys, session digests or private provider credentials. Normal responses may contain the ephemeral **app access JWT** in JSON, never a refresh token.
- `Origin` must equal configured public web origin and Fetch Metadata must be consistent with a same-origin browser for each browser mutation. No-Origin *public health* requests still allowed. A signed ingress header, if deployed, does not replace user auth, Origin or CSRF. Requests without valid trusted public ingress context fail before auth routing in proxy mode.
- Protected routes: `Authorization: Bearer <Roundset access JWT>` only, verified against persistent current user+session. Cookie *never* substitutes for Bearer except the explicitly cookie-authenticated refresh/logout operations. Client never supplies `userId`, `role`, `plan`, verification state or epoch for authority.
- **Session-cookie authenticated** refresh/logout operations require strict Origin + `Sec-Fetch-Site` policy + exact `X-CSRF-Token`/readable cookie equality, valid HMAC and CSRF `sessionId===refresh.sessionId`. A valid, unexpired Bearer accompanying a refresh cookie must refer to the same session; an *expired* Bearer is ignored for cookie-primary logout. CORS must allow `X-CSRF-Token`. No credentialed cross-site CORS. **Separate pre-session exception:** `/auth/verify-email` and `/auth/otp/resend` require the registration ID, HttpOnly registration nonce cookie and strict Origin/Fetch Metadata, **not** a session-bound CSRF token (no session exists yet).
- All times UTC ISO-8601; time arithmetic server-authoritative. Errors publicly generic before proof of account. Auth routes use the **numeric default caps in §4.4**, with per-operation/per-principal, coarse in-memory and persistent Mongo limits. Return `Retry-After` with 429. Public registration/recovery responses must be account-existence independent, including during email-provider failures. Do not emit user-existence indicators in messages, metadata or transport status.

### Session JSON envelope (200; only login / Google exchange / refresh)

```json
{
  "data": {
    "accessToken": "<ephemeral-app-jwt>",
    "tokenType": "Bearer",
    "expiresInSeconds": 600,
    "user": {
      "id": "507f1f77bcf86cd799439011",
      "email": "member@example.test",
      "emailVerified": true,
      "displayName": "Test Candidate",
      "role": "CANDIDATE",
      "accountStatus": "ACTIVE"
    },
    "session": {
      "id": "<random-session-id>",
      "expiresAt": "2026-12-22T16:00:00.000Z"
    }
  },
  "meta": { "requestId": "00000000-0000-4000-8000-000000000000" }
}
```

All strings shown above are **examples only**; do not use them as real credentials. Browser receives separate `Set-Cookie` headers for opaque refresh and signed CSRF, both **candidate** 7-day sliding max age (ADMIN uses a shorter mode-bound session TTL; §4.4). The access JWT is memory-only.

## 2. Phase 2 endpoint matrix (documentation approval candidate)

| Method and path | Authentication | Strict request shape | Success / state transition | Key failure |
|---|---|---|---|---|
| `GET /auth/meta` | Public | none | `200` `{activePolicyId,activeConsentVersion,registrationMode}` with no secrets, `Cache-Control: no-store` | 503 only for service-wide unavailability |
| `POST /auth/register` | Public; admission/rate/Origin | `{email,password,displayName?,consentVersion}` | `202` `{registrationId,message}` + short-lived `__Host-roundset_reg` HttpOnly cookie; validate current server consent version **before account lookup**; apply durable per-email combined bucket and cooldown **for both existing and unknown emails before existence branch**; pending replacement cooldown; verified accounts untouched; uniform public response independent of account presence | 429; **any** global 503 decision made before identity lookup, identically for all subjects |
| `POST /auth/verify-email` | Registration nonce cookie + OTP + Origin | `{registrationId,code}` | `204` pending consumed + verified `users` and `PASSWORD` identity in a **single transaction**; clear nonce cookie; user must login next | uniform 400 `OTP_INVALID`, 409 `STATE_CONFLICT`, 429 |
| `POST /auth/otp/resend` | Same registration nonce cookie + Origin | `{registrationId}` | `202` generic; atomic replacement of that registration's code and generation | 429; no `purpose` allowing other workflows |
| `POST /auth/login` | Public + Origin/rate | `{email,password}` | `200` session JSON; only active verified PASSWORD identity | 401 `INVALID_CREDENTIALS`; proven-password suspension 403 |
| `POST /auth/google/exchange` | Verified Firebase Google ID token + Origin/rate | `{firebaseIdToken,consentVersion?}` | `200` session JSON; existing linked UID signs in without new consent parameter or modifying recorded consent; **new** user must submit the currently advertised server policy version before provisioning | 400 `CONSENT_REQUIRED` on new-user missing/stale consent; 403 `REGISTRATION_RESTRICTED`; 409 `IDENTITY_LINK_REQUIRED` |
| `POST /auth/password/forgot` | Public + Origin/rate | `{email}` | `202` identical public response for eligible/ineligible identities; provider failures never cause identity-specific HTTP 503; purpose-scoped OTP only when valid, version-bound account exists | 429; global 503 only if selected **before** account lookup for all requests |
| `POST /auth/password/reset` | Purpose-scoped OTP + Origin/rate | `{email,code,newPassword}` | `204`; one transaction checks **challenge-bound userId, passwordIdentityId, identityVersionAtIssue, canonical email, ACTIVE status and current credential**; consumes challenge, updates password, bumps epoch/version and globally revokes previous sessions | uniform 400 `OTP_INVALID` for stale/invalid proof; 429/503 globally controlled |
| `POST /auth/reauth` | Bearer + Origin | `{action,target?,method:'PASSWORD',password}` OR `{action,target?,method:'FIREBASE_GOOGLE',firebaseIdToken}` | `200` `{reauthTicket,expiresAt}`; stores **methodUsed** + action/target/user/session/epoch/version; enforces closed allowed-method matrix (§3.4) on issuance and consumption; unknown or foreign `REVOKE_OTHER_SESSION` target has identical 404 status/error shape at issuance | 403 `REAUTH_REQUIRED`, 404 for unknown/foreign target, 429 |
| `POST /auth/password/change` | Bearer + PASSWORD reauth for CHANGE_PASSWORD | `{newPassword,reauthTicket}` | `204`; atomic hash change+epoch/version bump, revoke **all** sessions, clear current cookies, require new login | 403 `REAUTH_REQUIRED`; 409 |
| `POST /auth/refresh` | Refresh cookie + signed CSRF + Origin | empty JSON `{}` | `200` session JSON; one CAS rotation; two separate new cookies, **remaining principal/role-bound idle TTL capped by absolute session expiry** | 401 `AUTH_REQUIRED` or `SESSION_REPLAY_DETECTED` |
| `POST /auth/logout` | Refresh cookie + CSRF OR Bearer-only when cookie absent | `{}` | `204`; idempotent current-session revoke + cookie clear; bearer and cookie must agree if both present | 403 for mismatched session, **no server revocation and no cookie clearing** |
| `POST /auth/logout-all` | Bearer + Origin; no separate high-risk reauth requirement | `{}` | `204`; increment user's sessionEpoch and revoke sessions; clear cookies | 401/403; emergency logout cannot be blocked by unavailable reauth |
| `POST /auth/identities/link-google` | Bearer + PASSWORD ticket action LINK_GOOGLE | `{firebaseIdToken,reauthTicket}` | `200` `{provider:'FIREBASE_GOOGLE',linkedAt}`; **new linked Google proof has recent `auth_time` (≤300s, ≤30s future skew)**, email matches canonical, UID unique; transaction writes user identityVersion | 403/409 |
| `POST /auth/identities/link-password/start` | Bearer + GOOGLE ticket action LINK_PASSWORD | `{reauthTicket}` | `202` generic; sends purpose LINK_PASSWORD OTP to user's verified canonical email via `emailSendBudget.generalUsed` (not recovery reserve), **validates but does not consume** ticket | 429, 503 |
| `POST /auth/identities/link-password` | Bearer + GOOGLE ticket action LINK_PASSWORD + purpose OTP | `{newPassword,emailCode,reauthTicket}` | `200` `{provider:'PASSWORD',linkedAt}`; ticket+OTP consume atomically with identity creation/version bump | 400 `OTP_INVALID`; 403/409 |
| `POST /auth/identities/:provider/unlink` | Bearer + `UNLINK_IDENTITY` action/target ticket from **remaining** linked factor | `{reauthTicket}`; provider enum PASSWORD/FIREBASE_GOOGLE | `204`; one transaction guards ≥2 factors, shared user version/epoch CAS, removes target, globally revokes sessions | 403, 409 `STATE_CONFLICT` |
| `GET /auth/sessions` | Bearer | none | `200` `{sessions:[{id,createdAt,lastUsedAt,isCurrent,approxDeviceLabel}]}` | 401 |
| `POST /auth/sessions/:sessionId/revoke` | Bearer; step-up `REVOKE_OTHER_SESSION` ticket for other-device target | `{reauthTicket?}` (required for other device) | `204`; only session of current principal; self session clears cookies | 404 for nonexistent **or foreign** session; 403 only for missing/invalid proof on owned other-device session |
| `POST /auth/phone/start` | Bearer + Origin/rate | `{phoneE164}` | `202` only when **approved SMS provider active** or visibly mocked in development; no sign-in | production 503 when real SMS disallowed |
| `POST /auth/phone/verify` | Bearer + PHONE_VERIFY code | `{phoneE164,code}` | `200` `{phoneE164,phoneVerifiedAt}` under permitted provider; no auth session | 400/429/503 |
| `GET /me` | Bearer | none | `200` `{id,email,emailVerified,displayName,role,accountStatus,linkedProviders,consentVersion,preferences,phoneVerifiedAt?}` | 401/403 |
| `PATCH /me` | Bearer + Origin | `{displayName?,preferences?}` | `200` sanitized self-profile; exact field allowlist, no consent/status/plan fields | 400/403 |
| `POST /me/consent` | Bearer + Origin | `{consentVersion}` | `200` `{consentVersion,consentAt}`; must equal current server policy version; **atomically append immutable `CONSENT_ACCEPTED` event with userId, policyId, consentVersion, consentAt and eventId**; history included in export | 400 for obsolete/unknown version |
| `GET /me/data-export` | Bearer | none | `200` JSON `identityProfile`, `linkedProviderTypes`, `consentHistory`, `accountStatus`, timestamp; no secret/other user | 429; no paywall |
| `POST /me/account/delete` | Bearer + action-bound `DELETE_ACCOUNT` ticket | `{reauthTicket,confirmation:'DELETE MY ACCOUNT'}` | `202` `{status:'PENDING_DELETION',requestedAt}`; epoch bump + app-session revoke; Firebase revoke and retryable purge with tombstone retained pending external cleanup | 403/409; cannot delete sole admin |

**Contract compatibility notes:** Phase 2 phone endpoint is an authenticated *contact verification* endpoint (not a public passwordless login); the original API map's `POST/GET /me/data-export` is narrowed to GET for Phase 2 synchronous auth records; `POST /me/consent` replaces insecure client-mutable consent in PATCH. No VIP invitation, paid billing or new business plan behavior is implemented here. `admissionToken` is **not** accepted in Phase 2. The OTP issuance route for `LINK_PASSWORD` is deliberately distinct from verification/reset purposes.

## 3. Detailed proof-of-identity transaction protocols

### 3.1 Pending registration, session issuance and collision handling

**Pending record creation** (`POST /auth/register`): enforce PUBLIC/INVITE_ONLY admission + abuse controls, canonicalize email, validate password, bounded Argon2id hash; do not touch `users`/`authIdentities`. Generate `registrationId` and random nonce; store only nonce digest and OTP keyed digest. Atomic upsert/replacement by unique email **invalidates all earlier registration IDs/nonces**, but only if a **persisted per-email replacement cooldown (60s) and combined register/resend window cap (3 per 15m)** allow it. The attacker cannot reset caps by deleting/replacing a pending record; the counter is stored separately in `authRateLimits`. Cooldown or rate-limit rejection must return the same `429` status/body for existing and unknown addresses; rejected requests do not overwrite any existing registration. Rate-accepted registrations return the same generic `202` even if the email already belongs to a verified user. Local challenge delivery must show `deliveryState=ACCEPTED` to permit verification; `PENDING` and `FAILED` cannot verify. TTL 15 minutes for pending state, OTP lifetime 5 minutes. Never log password, nonce, OTP or email. Generic response + equal-shaped cookie even if user already active.

**Verification** (`POST /auth/verify-email`): validate registrationId, cookie-embedded ID+nonce, HMAC digests and 6-digit OTP; require pending status SENT, attempts <5, OTP accepted and not past expiresAt. Within one transaction: conditionally mark pending consumed -> insert `users` ACTIVE verified -> insert `authIdentities(PASSWORD)` for the *same* hash stored on this exact pending attempt -> append immutable `CONSENT_ACCEPTED` event with server policyId/version/timestamp -> consume admission allowlist only if necessary. Unique `(provider,subject)` and live canonical user email enforce no duplicate principal. A Google user created in the meantime wins uniqueness; OTP completion fails with no password identity attached. Return 204 and clear temporary nonce cookie; a subsequent `/auth/login` is the only email/password sign-in. In a transaction failure, no partial user/password or consumed nonce survives.

**Email-sender failures:** HTTP 2xx acceptance does not prove inbox delivery; mark challenge ACCEPTED only on provider acceptance. Never hold a transaction open during HTTPS calls. A stale provider callback/response cannot mark a *newer* challenge generation ACCEPTED. Unknown delivery state => safe resend UX under caps, not issuance of a session.

**Registration nonce protocol:** CSPRNG registrationId ≥128 random bits, nonce ≥256 random bits; `__Host-roundset_reg=reg1.<registrationId>.<nonce>` is `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=900; no Domain` in HTTPS production. `roundset_reg` is permitted only for `http://localhost`/loopback development with `HttpOnly; SameSite=Lax; Path=/; Max-Age=900`, never production. Store a keyed nonce digest (not raw nonce); check cookie ID equals JSON ID, digest and pending generation, attempts and TTL using constant-time comparisons. For verify/resend, **strict Origin and Fetch Metadata plus the browser-bound nonce** apply; there is no session-CSRF cookie before login. A missing Origin or cross-site request fails.

### 3.2 Authenticated credential linking and unlinking

`reauthTicket` is random 256-bit opaque; store `ticketDigest`, `userId`, `sessionId`, `action`, `target?`, **`methodUsed`**, `sessionEpochAtIssue`, `identityVersionAtIssue`, `expiresAt`, `consumedAt`. `POST /auth/reauth` validates the requested action enum and permitted target, then proves PASSWORD or linked Firebase UID (fresh `auth_time`). A ticket is **validated without consumption** when starting `LINK_PASSWORD` OTP and consumed **exactly once** in the transaction that adds the PASSWORD identity. OTP is bound to current `userId`, canonical email digest, purpose and ticket digest/ID; a second start may supersede only under resend throttles. No other OTP purpose authorizes linking.

For credential additions/removals: open a Mongo transaction, `findOneAndUpdate` on the shared `users` document with current `identityVersion` and `sessionEpoch` predicates (increment `identityVersion`), verify factor count and unique index obligations, atomically consume ticket, mutate target identity. **Unlink** also increments `sessionEpoch`; transaction must be retried at most a bounded number of times from a *fresh snapshot*, and if count becomes 1 it must reject removal. **No transaction may decide factor count from an old snapshot then delete a disjoint identity without a shared user-document write.** Account and session remain authoritative even if previous JWT still has time left.

Password reset/change atomically consume their proof and update hash + epoch/version, then all prior tokens are denied. Physical session status updates can be completed idempotently; epoch check is immediate logical revocation.

### 3.3 Verified Firebase Google proof and fresh step-up

Use configured Firebase Admin `verifyIdToken(idToken,true)` at exchange and linking, with bounded provider call concurrency/timeout handling. Require correct project, issuer/audience, valid signature/expiration, verified email and Google provider claim. For a linked user, map strictly by verified UID. For a **new** verified Google UID, read `GET /auth/meta` (`activePolicyId` and `activeConsentVersion`) and require the identical `consentVersion` at first provisioning; append immutable `CONSENT_ACCEPTED` event in the principal-provisioning transaction; absent/stale returns `400 CONSENT_REQUIRED` plus the publicly safe current version. For an **existing linked** UID, `consentVersion` is optional: ignore any supplied version for persistence and never treat a login as policy acceptance. If fresh consent is mandatory for continued product use, request it separately via authenticated `/me/consent`. For **reauth**, require `decoded.uid === authIdentities(FIREBASE_GOOGLE).subject` belonging to current principal, and `now - decoded.auth_time <= 300s` with <=30s future tolerance; `iat` is irrelevant to freshness. A mere `getIdToken(true)` refresh is insufficient; frontend must perform a Firebase reauthentication flow. Never automatically merge on matching email or take user role from Firebase claims. **For attaching a new Google identity**, additionally require incoming token `auth_time` no older than 300 seconds (≤30 seconds future skew); merely valid but stale ID token is not adequate new-factor proof.

### 3.4 Closed reauthentication action / target / method rules

| Action | Target | Allowed freshly proven method | Additional precondition |
|---|---|---|---|
| `CHANGE_PASSWORD` | null | `PASSWORD` | A PASSWORD identity exists |
| `LINK_GOOGLE` | null | `PASSWORD` | Google identity absent; new Google ID token in the *link endpoint* must have `auth_time` within 300 seconds |
| `LINK_PASSWORD` | null | `FIREBASE_GOOGLE` | Password identity absent; verified canonical email exists |
| `UNLINK_IDENTITY` | `PASSWORD` | `FIREBASE_GOOGLE` | Both identities linked; unlinking PASSWORD leaves Google |
| `UNLINK_IDENTITY` | `FIREBASE_GOOGLE` | `PASSWORD` | Both identities linked; unlinking Google leaves PASSWORD |
| `REVOKE_OTHER_SESSION` | a UUID-like sessionId owned by same user | `PASSWORD` or `FIREBASE_GOOGLE` | Target session belongs to same user; target checked at issue + consumption |
| `DELETE_ACCOUNT` | null | `PASSWORD` or `FIREBASE_GOOGLE` | Cannot delete last bootstrap administrator |

Reject all other combinations at issuance **and** at consumption. Validate `methodUsed` persisted on the hashed ticket, current linked factor, UID/current password proof, `identityVersion`, `sessionEpoch`, target owner and single-use CAS in same transaction. Changing factor state invalidates pending tickets. `LINK_PASSWORD` can start an email challenge while ticket is unconsumed, but completion requires **both** ticket and challenge independently unexpired; UI must display the earliest expiry and permit a new reauth if one lapses. No artificial extension of five-minute step-up validity.

## 4. Exact MongoDB collections, indexes and validity checks

**Indexes must be applied and verified in real MongoDB before auth readiness is advertised.** Use Mongoose explicit indexes and a migration/inventory check; do not rely on implicit `autoIndex` in production. `unique` is a DB index obligation, not only a Zod/Mongoose validator. TTL is cleanup only, never a validity check. All multi-document consistency tests require a real replica-set topology.

| Collection | Required fields and invariant | Exact critical indexes (Mongo notation) |
|---|---|---|
| `pendingRegistrations` | `registrationId`, `emailNormalized`, `passwordHash`, `nonceDigest`, `otpDigest`, `version`, `attempts`, `resendCount`, `state:PENDING_DELIVERY/SENT/CONSUMED`, `deliveryState:PENDING/ACCEPTED/FAILED`, `otpExpiresAt`, `expiresAt`, `consentVersion`, `displayName?` | `unique({registrationId:1})`; `unique({emailNormalized:1})`; `TTL({expiresAt:1}, expireAfterSeconds:0)` |
| `users` | `_id`, `emailNormalized?` (must exist only on live/pending-deletion accounts), `emailVerifiedAt`, `displayName`, `role:CANDIDATE/ADMIN`, `accountStatus:ACTIVE/SUSPENDED/PENDING_DELETION/DELETED`, `sessionEpoch:int`, `identityVersion:int`, `preferences:{language?:'en',reducedMotion?:boolean,timezone?:string}`, `consentVersion`, `consentAt`, `phoneE164?`, `phoneVerifiedAt?`, `createdAt`, `updatedAt` | `unique({emailNormalized:1}, partialFilterExpression:{emailNormalized:{$type:'string'}})`; optional `unique({phoneE164:1}, partialFilterExpression:{phoneE164:{$type:'string'}})`; index `{accountStatus:1,createdAt:1}` |
| `authIdentities` | `_id`, `userId`, `provider:PASSWORD/FIREBASE_GOOGLE`, `subject` (`emailNormalized` or verified Firebase UID), `passwordHash?` PASSWORD only, `linkedAt`, `lastUsedAt` | `unique({provider:1,subject:1})`; `unique({userId:1,provider:1})`; index `{userId:1}` |
| `sessions` | `sessionId`, `userId`, `status:ACTIVE/REVOKED/COMPROMISED/EXPIRED`, `generation`, `currentRefreshDigest?`, `epochAtIssue`, `createdAt`, `lastUsedAt`, `idleExpiresAt`, `absoluteExpiresAt`, `approxDeviceLabel?`, `revokedAt?`, `revokedReason?` | `unique({sessionId:1})`; `unique({currentRefreshDigest:1}, partialFilterExpression:{status:'ACTIVE',currentRefreshDigest:{$type:'string'}})`; `{userId:1,status:1,lastUsedAt:-1}`; `TTL({absoluteExpiresAt:1},0)` |
| `verificationChallenges` | one mutable slot per `purpose,subjectDigest`: `challengeId`, `purpose:RESET_PASSWORD/LINK_PASSWORD/PHONE_VERIFY`, `subjectDigest`, **`userId` (required for recovery and authenticated flows), `identityVersionAtIssue` (required RESET_PASSWORD), `passwordIdentityIdAtIssue` (required RESET_PASSWORD)**, `sessionId?`, `reauthTicketDigest?`, `otpDigest`, `generation`, `attempts`, `resendCount`, `state:ISSUED/CONSUMED/INVALIDATED`, `deliveryState:PENDING/ACCEPTED/FAILED`, `expiresAt`, `createdAt`, `consumedAt?` | `unique({purpose:1,subjectDigest:1})`; `unique({challengeId:1})`; `TTL({expiresAt:1},0)`; all starts/resends use atomic generation-checked replacement/upsert |
| `reauthTickets` | `ticketDigest`, `userId`, `sessionId`, `action`, `target?`, `methodUsed:PASSWORD/FIREBASE_GOOGLE`, `sessionEpochAtIssue`, `identityVersionAtIssue`, `expiresAt`, `consumedAt?` | `unique({ticketDigest:1})`; `{userId:1,sessionId:1,action:1}`; `TTL({expiresAt:1},0)` |
| `authRateLimits` | `bucketKey` = HMAC(purpose, account/email or trusted-IP, window ID); `count`, `windowEnd`, `expiresAt` | `unique({bucketKey:1})`, TTL `expiresAt` |
| `emailSendBudget` | `dateKey` UTC day, `generalUsed:int`, `recoveryUsed:int` | `unique({dateKey:1})`; conditional atomic increments **before** each attempted provider send; general ≤180/day, recovery ≤60/day; total ≤240/day; no reservation leak on process crash |
| `registrationAllowlist` | `emailNormalized`, `expiresAt?`, `redeemedBy?`, `redeemedAt?`, operator `createdBy` | `unique({emailNormalized:1})`; handle TTL without losing immutable audit proof |
| `securityAuditEvents` | `eventId`, `eventType`, `actorId?`, `targetId?`, `requestId`, `outcome`, `reasonCode`, `at`, bounded metadata. **`CONSENT_ACCEPTED` requires `userId`, `policyId` from active server policy metadata, `consentVersion`, `consentAt` (server timestamps) and immutable eventId**, including first registration/Google provisioning. Its append and latest `users.consentVersion`/`consentAt` update are atomic; never update/delete acceptance events except explicit lawful retention/purge. History is self-exportable. | `unique({eventId:1})`, `{targetId:1,at:-1}`, `{at:-1}`; no indiscriminate TTL before retention policy approved |

`users.emailNormalized` is **unset** only after fully completed deletion/anonymization. **On entering `PENDING_DELETION`**, a transaction changes status, increments epoch and denies all local auth, while Firebase `revokeRefreshTokens(uid)` is requested with bounded retry/audit. All Google token exchanges fail closed for pending/deleted users even if external revocation is delayed. Before canonical email or provider-UID mapping is released, an idempotent purge runbook **(1)** confirms Firebase UID deletion (retry on failure, keep tombstone + mappings), **(2)** removes linked identities/sessions/challenges/tickets and dependent private records according to retention policy, **(3)** anonymizes user and releases email/contact fields only after external cleanup succeeds. An old reset challenge is always bound to old `userId`/identity-version and cannot mutate a newly provisioned user with the same email. Public register/forgot remain non-enumerating for pending/suspended accounts. At `PENDING_DELETION` it remains reserved, and provider UID/password identity cleanup must be completed/tombstoned before re-registration; do not let a deleted user's old Google identity map to a different principal. The retention/purge state machine and operator runbook must be tested before deletion is presented as completed. The DB should refuse auth readiness if required unique indexes are missing or invalid.

### 4.1 OTP atomic write contract

For a non-registration challenge, every start/resend targets the **same unique `(purpose,subjectDigest)` slot** with a new generation/challenge ID and fresh digest. Concurrent issuers use a version predicate; only the winning generation can be marked `deliveryState=ACCEPTED`, verified or consumed. **Every attempted guess (correct or wrong) must atomically claim one of at most five attempt slots BEFORE comparing the provided OTP digest** using one `findOneAndUpdate` with `state=ISSUED`, `deliveryState=ACCEPTED`, matching `generation/challengeId`, future `expiresAt`, and `attempts:{$lt:5}`, then `$inc:{attempts:1}` and return the matched generation. Compare digests in constant time ONLY after a slot was claimed; a sixth concurrent request cannot compare any guess. Apply the identical atomic pre-claim protocol to `pendingRegistrations` (require `state=SENT`, current `registrationId`/nonce, accepted delivery, future OTP expiry). No check-then-increment or compare-then-increment is permitted. A correct proof conditionally consumes the *same* generation **in one transaction with the protected change** (password hash, identity addition, phone contact). Conditional failure cannot perform a protected action; expired/used/wrong/challenge-not-present share `400 OTP_INVALID` on unauthenticated endpoints. Sending outside transaction is accepted with safe failure UX; no false guarantee of inbox receipt.

**Password recovery version binding (mandatory):** At issuing a `RESET_PASSWORD` challenge, bind `userId`, `passwordIdentityIdAtIssue` (immutable credential `_id`), `identityVersionAtIssue`, **canonical email through the purpose-scoped `subjectDigest` (do not add raw email to challenge)**, and the generation. `POST /auth/password/reset` must, **in one transaction**, conditionally update `users` with `_id=userId`, `accountStatus=ACTIVE`, `identityVersion=identityVersionAtIssue`, `emailNormalized=emailAtIssue`, write `$inc:{identityVersion:1,sessionEpoch:1}`, verify the current PASSWORD identity has the same `_id` and owner, update its Argon2id hash, and atomically mark **the same** challenge consumed. Transaction conflicts/changed versions => uniform `OTP_INVALID` for public requests; no partial effect. Password change, reset, identity link/unlink, deletion and canonical-email changes make outstanding challenges stale by the version/ID mismatch. Optional explicit invalidation is defense in depth; version and identity binding is the authority. A challenge from a deleted principal cannot affect a different user who later acquires that email.

**Challenge slot identity:** `RESET_PASSWORD` slot key is `HMAC(secret,'RESET_PASSWORD|'+emailNormalized)`, with user+identity version stored as above. `LINK_PASSWORD` slot key is `HMAC(secret,'LINK_PASSWORD|'+userId+'|'+emailNormalized)` plus binding to the ticket digest and session; `PHONE_VERIFY` slot key is `HMAC(secret,'PHONE_VERIFY|'+userId+'|'+phoneE164)`. All digest inputs use length-safe domain separation and the same stable canonicalization policy. Another user's phone/start never overwrites a claimant's active OTP; unique verified phone/contact ownership remains enforced at commit.

### 4.2 Refresh CAS contract and errors

Token fields: `r1.<kid>.<sid>.<gen>.<secret>.<MAC>`, cryptographically random secret >=256 bits. Verify `kid`, MAC and syntax **before** looking up and potentially changing the target session. Compute keyed `currentRefreshDigest` of complete provided token. Then CAS matching `sessionId`, `status:'ACTIVE'`, `generation:gen`, `currentRefreshDigest`, valid epochs, and both unexpired dates, updating generation/digest/idle expiry and lastUsedAt. Only one successor can commit. If MAC invalid -> generic 401, no revocation. If session expired/revoked/user epoch mismatch -> 401, no security-replay assertion. If MAC authentic and token generation older than still-active current generation -> revoke this session family, `401 SESSION_REPLAY_DETECTED`, record *uncertain* evidence of theft vs race. Other state inconsistencies fail closed/audit. No blind refresh retries. Candidate max idle seven days/absolute 30 days; ADMIN 12h idle/24h absolute; keys retained as specified in architecture.

### 4.3 Secret key and profile policy

- JWT: EdDSA/Ed25519 via audited `jose` is the approved-design `auth.v1` signing algorithm (lock approved version before code). Every JWT has validated `alg`, `kid`, `iss`, `aud`, `sub`, `sid`, `jti`, `iat`, `exp`, `epoch`; status and role from DB, not JWT.
- Refresh: versioned HMAC key ID, distinct domain-separated digest key; CSRF: independent HMAC key ID with `c1.<kid>.<sid>.<nonce>.<mac>`; signed token's session ID must match refresh session ID. CSRF cookie has the same principal/session-specific sliding TTL as refresh and is refreshed whenever refresh cookie rotates. No keys in URLs/logs/frontend bundles.
- Password: proposed 12–128 Unicode code points, max 512 UTF-8 bytes, reject NUL/control, normalize to Unicode NFC identically for both signup and login **before Argon2id**, and do not silently truncate. Argon2id initial floor 19 MiB/t=2/p=1 with measured resource ceilings. Email: <=254 ASCII characters, lowercased app key, reject control/CRLF, do not strip dots/plus. OTP six decimal digits, five-minute lifetime, five attempts, purpose-specific.
- `/me` preferences allow only `language:'en'`, `reducedMotion:boolean`, `timezone:string` (max 64, validate IANA time zone). `consentVersion` can be set only through `/me/consent` against the backend's active policy version. Separate immutable audit event on acceptance.

### 4.4 Auth security defaults and bounded resource budgets (reviewed design values)

The following **initial ceilings** are enforceable server-side, **not verified free-tier load capacities**; permit a documented config-only reduction where risk/capacity demands. Persistent per-subject/IP counters use durable, shared `authRateLimits` keys independent of replaceable registrations. Per-IP/global cheap in-process shedding happens **before** database and Argon2 work; persistent counters remain mandatory across process restarts. Retry-After must not reveal whether a subject exists.

| Route group | Default subject cap | Default trusted-IP cap | Notes |
|---|---|---|---|
| Register + resend (combined) | **3 email-triggering requests / 15m per canonical email**, **60s between replacement** | 10 / 15m | **Validate consentVersion and increment combined durable subject bucket / enforce cooldown before identity lookup, identically for existing and unknown email addresses**; same bucket across register and resend even when pending replaced. Initial pending registration is not a durable user claim. |
| Login | 5 failed credential attempts / 15m per email key | 30 / 15m | Apply subject key to unknown accounts too; bounded Argon2id dummy path |
| Verify email | 5 OTP attempts per registrationId | 20 / 15m | Also reject expired/overwritten nonce without revealing account |
| Google exchange | 10 / 15m per verified Firebase UID after token proof | 30 / 15m | Pre-verification IP/global limiter always first |
| Password forgot | 3 / 60m per email key | 10 / 15m | Reserve recovery email quota; generic responses and uniform status |
| Password reset | 5 / 15m per email key; 5 tries/challenge | 20 / 15m | Credentials/identity version verified in transaction |
| Reauth | 5 / 15m per user | 20 / 15m | Method and action scoped, no unlimited hash/provider calls |
| Link-password/start | 3 / 15m per user | 20 / 15m | Also uses global email budget; valid step-up ticket required |
| Phone/start | 3 / 15m per user | 20 / 15m | Mock in dev only; no real SMS without exception |
| Data export | 3 / 60m per user | 20 / 15m | Self-only, non-premium privacy access; avoid expensive abuse |
| Pre-DB flood shedder | — | **60/min** | Plus **global 120/min** per API process. Conservative portfolio-demo safety defaults; adjust only after measured evidence and review. |

Argon2id capacity remains two concurrently executing operations, eight queued, ≤3s queue wait, initial 19 MiB/t=2/p=1; fail closed rather than OOM speculation. **Email send budget** on UTC day uses **two independent, crash-safe atomic counters**; do not assume Brevo resets on UTC midnight. Before live delivery, verify actual free-account quota/reset behavior and either align budget windows to the verified provider interval or enforce an additional conservative rolling-24-hour gate, including across boundary bursts. Unknown reset behavior blocks live-email readiness, not D3 design approval: `generalUsed` increases only if `<180`, `recoveryUsed` only if `<60`; both increment *before* external HTTP send, so total ≤240. Failed/uncertain requests are conservatively counted and never retried unboundedly; a crash cannot leak a reserved pending balance. `LINK_PASSWORD` issuance consumes **generalUsed**, never the password-recovery reserve (`recoveryUsed` strictly belongs to `/auth/password/forgot`). No sends outside these gates. Remaining budget can still be exhausted by a distributed targeted attack: rate controls and reserve reduce risk but do not prove immunity. No third-party CAPTCHA is silently introduced. External Brevo acceptance does not prove five-minute inbox delivery.

**Public account-enumeration rule:** For syntactically valid, rate-accepted `/auth/register` and `/auth/password/forgot`, decide any globally unavailable dependency state **before** account lookup and return the same HTTP status/body independently of account existence. On subsequent per-recipient email send failure, do not return an identity-specific `503`: persist a sanitized internal delivery failure, return the standard `202`, and offer retry/resend through rate-limited UX. Use a bounded response-latency floor measured against provider/DB behavior; treat timing equality as a tested distribution goal, not a mathematically guaranteed constant time. Never generate a fake session or claim delivery. Global budget exhaustion returns a uniform pre-lookup 503 (or a globally uniform 202, configured consistently). Tests compare status/body **and timing distributions** across known/unknown accounts and provider errors.

**Privilege/session policy:** Candidate refresh idle 7 days and absolute 30 days; ADMIN idle **12 hours** and absolute **24 hours**. Refresh/CSRF cookie Max-Age equals the *remaining session idle TTL bounded by absolute expiry* on every issuance/rotation. Admin elevation/demotion revokes previous sessions; expired Bearer never blocks cookie-primary logout. When session revocation target is foreign or nonexistent return **404** for both.

## 5. Error contract and anti-enumeration

| HTTP | Code | Meaning / externally observable behavior |
|---|---|---|
| 400 | `CONSENT_REQUIRED` | new Google-user provisioning lacked current policy consent; active version is public metadata, no identity leak beyond already verified Google proof |
| 400 | `INVALID_INPUT` | malformed body, extra security-sensitive fields, invalid email/password format |
| 400 | `OTP_INVALID` | wrong, expired, used, unavailable or non-existent *unauthenticated* OTP/challenge — same body shape; never distinguish account existence |
| 401 | `AUTH_REQUIRED` | absent/invalid/expired JWT, refresh token or session |
| 401 | `INVALID_CREDENTIALS` | unknown email or wrong password, uniform body; dummy Argon2 path within resource cap |
| 401 | `SESSION_REPLAY_DETECTED` | MAC-valid prior refresh generation for still-active session; user relogin (no claim theft was proven) |
| 403 | `EMAIL_UNVERIFIED` | known account after proven password, where applicable; Phase2 pending users have no credential and cannot log in |
| 403 | `ACCOUNT_SUSPENDED` | already-authenticated/proven principal suspended; no unproven enumeration |
| 403 | `REAUTH_REQUIRED` | wrong/expired/used/action-mismatch ticket, stale provider `auth_time`, wrong factor |
| 403 | `FORBIDDEN` | Origin/CSRF/role/admission or resource policy |
| 403 | `REGISTRATION_RESTRICTED` | new verified Google signup disallowed by admission mode |
| 409 | `IDENTITY_LINK_REQUIRED` | verified new Google UID collides with existing verified canonical email; no account details returned |
| 409 | `IDENTITY_ALREADY_LINKED` | authenticated link attempt UID/provider already owned/attached |
| 409 | `STATE_CONFLICT` | concurrent CAS, last-factor unlink, repeated pending verification or deletion conflict |
| 429 | `OTP_RATE_LIMITED` / `AUTH_RATE_LIMITED` | calculated retry window; no paid fallback |
| 503 | `AUTH_PROVIDER_UNAVAILABLE` | uniform **global pre-lookup** unavailability on public registration/recovery; recipient-specific delivery failure stays generic 202, internally recorded; other authenticated provider failure may use 503 |
| 500 | `INTERNAL_ERROR` | sanitized error envelope, no stack or secret |

`OTP_EXPIRED` from legacy contracts is not used on public reset/verification routes because a different status for existing challenges could leak account existence. An authenticated challenge UX may provide a generic expired notice only after verified ownership, under a separate approved contract.

## 6. Required implementation acceptance tests (not results)

1. Attacker pre-registers victim's email/password A; rightful owner creates a new pending registration/password B, verifies in owner browser. Password A never usable. Previous `registrationId`/nonce/code rejected; Google verified email not blocked by pending record.
2. Two parallel registrations replace safely; no duplicate live users. Google provisioning vs pending OTP verify race yields no automatic attachment. Verify never creates a session, even with OTP alone.
3. Malformed/forged/wrong-project/revoked/disabled/non-Google Firebase token fails. Existing linked UID with changed provider email does not auto-claim canonical ownership.
4. Cross-email Google linking or Google UID already linked elsewhere fails. Firebase reauth with recent `iat` but stale `auth_time`, or with a different UID, fails.
5. Reauth ticket user/session/action/target mismatch, used ticket reuse and concurrent consume fail. No protected effect without valid ticket.
6. `LINK_PASSWORD` OTP route issues only to verified canonical email, requires valid Google ticket and cannot accept a RESET_PASSWORD challenge. Two link/unlink attempts must serialize.
7. Concurrent last-factor unlinks leave at least one factor; password reset/change/unlink invalidates *all* previous sessions, including 10-minute access JWTs. Demoted admin JWT fails next request.
8. Refresh concurrently in two tabs permits a single successor; forged MAC never revokes victim; genuine prior authenticated generation causes bounded family revoke. Key rollover accepts existing valid key ID until expiry. Response loss yields explicit relogin UX, not duplicate tokens.
9. Day-five valid refresh with synchronized CSRF cookies succeeds; cookie from different session fails; missing Origin/CSRF/cookie, cross-site and forged Host/XFF fail; health remains callable without Origin.
10. Real replica-set Mongo DB index inventory asserts all unique indexes. Expired TTL document still logically invalid before deletion; failed transaction has no partial user/credential/code effect; duplicate null refresh digests don't block revoked sessions.
11. Argon2 burst is bounded by two active hashes and eight queued; failure is controlled 429/503. Durable abuse counters persist across process restart; recovery-email send reserve not exhausted by signup flood.
12. `/me` rejects `role`, `plan`, `emailVerified`, `sessionEpoch`, `consentVersion` in PATCH; self-export is own/nonsecret only; account deletion invalidates all credentials and prevents silent Firebase reprovisioning; mock email/SMS cannot satisfy production delivery acceptance.
13. Actual Pages→Render proxy forwards **two separate** cookie headers, preserves `no-store` and valid Origin, blocks direct Render auth, and authenticates trusted client IP; approved single-origin fallback tested if needed. HTML CSP and Firebase popup behavior tested on deployed web origin.
14. Root `npm ci`, lint, typecheck, tests, build, `npm audit --omit=dev`, secret scan and diff check pass with recorded exit codes; original 75 Phase 1 tests remain passing. No tests are marked complete until actually executed.

### 6.1 Additional adversarial acceptance tests for v1.2

15. Recovery OTP is issued at user A identityVersion N, then password **change** or another **reset** advances version; old OTP cannot change the credential. Repeat for unlink/relink of PASSWORD (different credential `_id`), `PENDING_DELETION`, and later unrelated principal B inheriting released email; no old reset acts on B. Concurrent reset+password-change has at most one coherent winner.
16. Two users request PHONE_VERIFY for identical phone; their `subjectDigest` slots do not collide and neither can claim a contact already verified by the other. `LINK_PASSWORD` challenges of different users cannot stomp each other.
17. Repeat `/auth/register` at the same unverified email to attempt to reset registration and resend counters; 60s replacement cooldown and combined durable 3/15m cap persist even if pending doc is replaced. Old nonce/codes fail.
18. Attempt each forbidden `(reauth action,target,methodUsed)` combination including UNLINK from removed factor; verify method is persisted and checked at consume. New Google link with old `auth_time` (but valid ID token) fails. No DELETE body is required for sensitive operations.
19. Returning verified Google user can exchange with **no** consentVersion and does not overwrite past consent; new Google user must learn active version via `GET /auth/meta` and provide it, otherwise 400 CONSENT_REQUIRED with version metadata.
20. Simulate email-budget exhaustion/provider failure for existing and unknown registration/reset targets; responses use indistinguishable status/body and tested bounded timing distributions. Crash during send never permits >180 general / >60 recovery (240 total) attempts in UTC day.
21. Expired Bearer + current refresh cookie + valid CSRF logs out cleanly; active Bearer from different session plus refresh cookie fails closed without revoking an unrelated session; foreign and nonexistent session revoke both return 404.
22. Production startup with `INGRESS_MODE=LOCAL` fails. Pages proxy strips untrusted hop-by-hop/forwarded headers and does not follow upstream redirects. Secret rollover validates both current/previous only during explicit rollout; direct Render auth fails; no-Origin health continues to work.
23. A failed Firebase external deletion leaves pending-deletion tombstone and identity mappings intact, blocks Google reprovisioning and retries idempotently; only after successful external deletion can canonical email/UID be released.


### 6.2 Final D2 delta acceptance cases (not executed)

24. **Parallel OTP attempt cap:** On real replica-set Mongo, run 20 simultaneous wrong-code requests plus an otherwise valid sixth request for both `/auth/verify-email` and `/auth/password/reset`; the atomic **pre-comparison** attempt claim limits digest comparisons to five, even when requests overlap. Only a request holding one of those five slots may consume a correct challenge; all others return uniform `OTP_INVALID` without checking the secret.
25. **Register anti-enumeration:** Four rapid registrations for already-active and unknown addresses, using the same valid current consent version, produce the same `429` status/body shape on capped requests; stale consent produces the same `CONSENT_REQUIRED` outcome before any identity lookup.
26. **Reauth target visibility:** `REVOKE_OTHER_SESSION` ticket issuance for a foreign and nonexistent session returns identical status/body.
27. **Consent history:** Accept two distinct active policy revisions A then B; self-export contains two immutable `CONSENT_ACCEPTED` events with original server timestamps, policyId and consentVersion; updating `users.consentVersion` does not rewrite history.
28. **Email quota provider boundary:** Simulate sends across UTC midnight and the verified Brevo free-account reset boundary; no queued/late OTP is claimed as five-minute delivery and configured counters cannot exceed verified provider allowance.
29. **Refresh key lifecycle:** Rotate refresh-token MAC and independent keyed refresh-digest keys while active tokens exist: old valid credentials continue only for explicitly retained keys, or owner-approved global relogin occurs; no silent reuse of an unknown key.
30. **Admin expiry:** Refresh near ADMIN 12-hour idle and 24-hour absolute limits uses matching CSRF/refresh cookie expiries, never candidate 7-day max-age.
31. **Firebase/own-session separation:** Revoking Firebase session after Roundset issues its JWT does not falsely imply immediate app-session invalidation; test explicit Roundset epoch/session revoke triggers separately.
32. **Documentation/route ownership:** Verify A05a owns `/auth/meta`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`; A07a owns `/auth/password/change`, A07b owns admin bootstrap.

## 7. Pending signoff and canonical migration

- `auth.v1` is a **D3 documentation approval candidate**, not proof of implemented endpoints. D1 revisions and D2 independent reviews are complete with verified corrections incorporated. D3 requires owner review and merge of ADR-028 plus reconciliation of `docs/API_AND_DATA_CONTRACTS.md`, `docs/ARCHITECTURE.md` and tracker. **No coding agent receives Phase 2 authorization until the D3 documentation PR has been merged with owner approval.**
- External account-specific validation (real Brevo inbox/sender, Atlas transaction behavior, Firebase settings, HTTPS browser cookie/popup, Argon2 peak RSS, Cloudflare quota and ₹0 guarantees) is an **implementation/release gate**, not a claim established by this document. Never silently switch to a paid service or broaden account-linking semantics to work around an obstacle.
