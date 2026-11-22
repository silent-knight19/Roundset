# AI Interviewer — Engineering Research and Architecture Decision Records

**Version:** 1.0 · **Evidence review:** 2026-11-22  
**Method:** The original project requirements and actual prototype CSV were examined. Current official vendor documentation and OWASP guidance were checked. Each entry distinguishes a **verified provider fact**, a **proposed implementation**, and a **required deployment test**. Limits and pricing are time-sensitive; links below must be rechecked before launch.

## Executive decisions

| ADR | Decision | Status | Rationale |
|---|---|---|---|
| ADR-017 | **Modular Express/TypeScript monolith**, React/TypeScript Vite, MongoDB | Chosen implementation | Best balance of portfolio engineering depth and ₹0 deployment; avoid operational complexity of services/queues. |
| ADR-018 | **Firebase Auth for Google only + custom email/password auth and app sessions** | Reaffirmed | Explicit user requirement; Firebase credentials not sole app authorization source. |
| ADR-019 | **Groq Qwen 3.8 27B** primary; **Cloudflare Qwen 3.8 27B** fallback | Chosen initial adapter order, fallback still untested | Consistent provider-neutral task contracts; measured Groq short-turn evidence exists. |
| ADR-020 | **Web Speech API + Silero VAD + Kokoro** in browser | Retain user-tested POC | Meets natural voice goal without recurring TTS expense. |
| ADR-021 | **Backend-authoritative state machine + MongoDB durable events/checkpoints** | Chosen | Recovery, integrity, quota and timer must survive refresh/backend restarts. |
| ADR-022 | **Atomic per-user-period usage document with idempotency audit ledger** | Chosen | Prevent double start/double bill under concurrent requests; use bounded embedded reservations. |
| ADR-023 | **Cloudflare Pages + thin Pages Function same-origin API proxy → Render Free**, fallback to Render single origin | Selected deployment candidate, integration test pending | Avoid reliance on cross-site cookies across `pages.dev`/`onrender.com` without buying a domain. |
| ADR-024 | **Sandbox billing only, provider-neutral adapter** | Fixed boundary | Payments aren't authorized; implement engineering skill, not live commercial service. |
| ADR-025 | **Strict premium data separation at API resource level** | Fixed | No server data leak via merely blurred UI; personal-data rights separate. |
| ADR-026 | **No heavy real-time services, streaming STT vendor, Redis or background worker requirement for v1** | Chosen | Free-tier compatibility, lowest operational risk. |
| ADR-027 | **Short-term app JWT + rotating HttpOnly refresh cookie, CSRF/origin protections, no secrets on frontend** | Chosen direction; cookie proxy test required | Multi-provider login convergence and revocable sessions. |

---

## 1. AI inference: exact evidence and decisions

### Groq

- Official free rate-limit page lists Qwen 3.8 27B around **30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD**; **actual organization/account limits override the public table**. Limits are organization-level, not per key. Use rate-limit headers to adapt. Source: https://console.groq.com/docs/rate-limits .
- Official model documentation confirms **`qwen/qwen3.8-27b`**, multi-mode reasoning and JSON object support. Sources: https://console.groq.com/docs/model/qwen/qwen3.8-27b and https://console.groq.com/docs/api-reference .
- **Critical schema nuance:** Groq's structured output documentation presently advertises `strict:true` support on GPT-OSS 20B/120B, **not on Qwen 3.8**. For Qwen use **JSON object mode**, parse and validate with Zod, optionally bounded single repair attempt; don't falsely assume constrained schema guarantee. Fallback to GPT-OSS *for strict-schema work only if justified by test quality*, not as an unnecessary extra provider. Source: https://console.groq.com/docs/structured-outputs .
- Groq's privacy documentation says inputs/outputs aren't retained by default for normal inference, but limited system reliability/abuse logs may be retained; **Zero Data Retention can be enabled** in account controls. This is not an excuse to omit user consent. Source: https://console.groq.com/docs/your-data .
- Archived **actual user metrics**: **16 Qwen successful calls, 4,281 input / 409 output / 4,690 total**, median API latency **651.5 ms**, max **7,699 ms**. The original CSV also has 2 other-model rows without input/output values and `0` latency; exclude those. Not a long-session capacity estimate; no evaluation scored in this sample.
- Groq primary cannot be assumed objectively more intelligent than GPT-OSS: the user's preference determines the **benchmark candidate**, and answer-scoring quality must be tested against golden examples.

### Cloudflare Workers AI

- Official Workers AI pricing: **10,000 free neurons/day** on Workers Free; beyond cap requests fail unless upgraded to Paid. Reset midnight UTC. **Never upgrade**, never preload paid AI Gateway credits. Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ .
- Model ID currently documented as **`@cf/qwen/qwen3.8-27b`**, with model-specific token/neuron rates; the pricing is per input/output tokens, not one fixed token daily quota. Sources: https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/ and pricing URL above. Default text-generation rate limit can differ from model limits and paid-only models; see https://developers.cloudflare.com/workers-ai/platform/limits/ .
- Source for Cloudflare's declared no-training treatment of customer content: https://developers.cloudflare.com/workers-ai/platform/data-usage/ . Specific privacy terms, retention, location and permissions still require account-level review before sending private resumes/transcripts.
- At the previously published model rate **~40,909 neurons per million input tokens** and **~290,909 per million output tokens**, one request's expected usage is `input/1e6*40909 + output/1e6*290909`, **not** a fixed “requests per day” number. Use Cloudflare's actual usage reports for authoritative charging. Rates may change. Reserve a buffer before daily cap.
- **Adapter requirements:** accept same internal `AIGenerationRequest`, translate roles and token limits, map response to `AIGenerationResult`, normalize errors, retain provider identifiers; compare against Groq using same gold cases. Enforce a provider-specific budget with margin and guard against concurrent requests racing over the last neurons.
- **Fallback rules:** eligibility depends on privacy class, quota, provider health and workload. On structured-output failure, don't blindly pass personal data to an alternative provider. Never retry endlessly or duplicate completed turns.

### Multi-provider gateway shape

```ts
interface AIProvider {
  id: 'groq' | 'cloudflare' | 'mock';
  generate(request: AIGenerationRequest, signal: AbortSignal): Promise<AIGenerationResult>;
  status(): ProviderHealth;
}

type AIPurpose = 'QUESTION' | 'FOLLOW_UP' | 'EVALUATION' | 'PLAN' | 'REPORT';
// metadata: requestId, interviewId, turnId, purpose, sensitivityClass,
// maxOutputTokens, model, deadlineMs, idempotencyKey.
```

Use mock in tests and when demonstrating non-sensitive scripted flow without API keys. Gateway owns **admission** (concurrency slots + daily local budgets), **dispatch** (Groq → Cloudflare only if allowed), **timeouts**, **idempotency** (dedupe in-progress/repeated logical generations), **usage logs** (never raw transcript) and **health**. No per-user fake key rotation. Don't host long blocking queues on Render Free; respond `PROVIDER_CAPACITY_UNAVAILABLE` or bounded wait.

### Token optimization sequence

1. Keep planner output structured and compact; generate question-by-question, not 50 questions upfront.
2. Pass active question, last 4–8 turns, 1 structured summary, interviewer behavior instructions and rubric references—no whole interview repeated in every call.
3. Separate fast dialogue turns from slower asynchronous per-question evaluation after answer is finalized.
4. Prompt cache if provider automatically offers it, but **never** make correctness depend on caching or falsely count all cached tokens as free.
5. Admin shows **request count, prompt/completion tokens, p50/p95 latency, 429 count, remaining free budget**.
6. At cap, block before sending; provider-native 429 triggers bounded backoff only if deadline and daily budget allow; otherwise gracefully pause or reject new session.

---

## 2. Speech, performance and privacy

- **TTS:** Kokoro 82M via `kokoro-js` runs in browser using WebGPU/WASM fallback; no remote per-token synthesis charges. Download model lazily and pre-warm during preflight. Original prototype declared `kokoro-js@1.2.1` and user approved perceived quality; keep pinned versions for first migration.
- **VAD:** Silero VAD via `@ricky0123/vad-web@0.0.31` in original POC. Detect start/end, but **VAD does not identify the speaker** and may mistake played AI audio as candidate speech. Measure speaker vs headphones; use echo cancellation and proper audio state.
- **STT:** browser `SpeechRecognition` / `webkitSpeechRecognition`. Vendor-based recognition may require Internet and sends audio outside local machine. On-device browser support exists in some browser versions (`processLocally`, `available()`, `install()`), but current POC did not enable it. Sources: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition and https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally . Add consent/indicator, fallback manual input, and possibly a local recognition option as a later optimization.
- **Barge-in:** when VAD speech-start happens during AI playback, cancel audio **and tag the current generation obsolete**; any late HTTP completion must not speak. No disconnection or accidental event may start another paid inference without admission.
- **End-of-turn:** avoid a rigid subsecond cutoff for technical answers; expose manual 'Done answering'. Split transcription from final submission so brief thoughtful pauses don't force a question change.
- **Privacy:** on-device Kokoro/Silero/MediaPipe doesn't mean the **entire** interview is local. Groq receives text; browser vendor may process audio. User consent, privacy notice and retention/delete features are mandatory before real-user rollout.

---

## 3. Hosting and session cookie reliability

- **Render Free:** service sleeps after ~15 minutes idle, cold starts ~one minute, 750 hours/month workspace allotment, ephemeral filesystem, 1 free instance; outbound SMTP ports 25/465/587 blocked; Render may charge supplemental overages if payment method is attached and spending isn't limited. Source: https://render.com/docs/free .
- **MongoDB Atlas M0/Free:** ~512 MB and shared compute, limit per project; no persistent log/archive or media blobs without limits. Source: https://www.mongodb.com/pricing and https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ .
- **Cloudflare Pages:** free static frontend, free build quota; Pages Functions count toward Workers Free request allotment. Sources: https://developers.cloudflare.com/pages/platform/limits/ and https://developers.cloudflare.com/pages/functions/pricing/ .
- **Cookie deployment gotcha:** browser frontend on `*.pages.dev` and backend on `*.onrender.com` means cross-site credentialed requests; `SameSite=None` may be blocked by privacy controls. A thin same-origin Pages Function proxy for `/api` solves browser-origin mismatch **if implemented/tested securely** and within free functions quota. Docs: https://developers.cloudflare.com/pages/functions/ and https://developers.cloudflare.com/pages/functions/routing/ . Fallback single-origin Express-served React.
- **Free storage and server restarts:** all authoritative state is in MongoDB. Avoid Redis on ephemeral plans. Cache only rebuildable model summaries in memory, and persist checkpoint summaries if needed.
- **No paid domain:** domain purchase is disallowed by ₹0 service policy. If a free sender domain/API requirement cannot be met, real email delivery remains a deployment gate, not permission to purchase a domain.

---

## 4. Authentication, cookies, sessions, OTP

### Firebase Google + custom backend

- Firebase client signs in with Google; send **Firebase ID token** to Express; Express uses Firebase Admin `verifyIdToken` for identity authentication, maps verified `(firebaseUid, provider)` to `authIdentities`, then issues **our own** app session. Source: https://firebase.google.com/docs/auth/admin/verify-id-tokens .
- Independently handle custom email+Argon2id/password and email verification/forgot/reset using Express, Brevo HTTP API and verification challenge records. **Do not replace custom email with Firebase email/password**: explicit user demands backend implementation of these skills.
- Account merge only after verified ownership proof of both identities; email string equality is not sufficient.
- Session policy: short-lived access JWT (e.g. 10 minutes) in memory, hashed rotating refresh token in secure HttpOnly cookie with strict origin/CSRF checks; session-family revocation on replay/theft detection; sign out all. Actual cross-origin cookie behavior is deployment-tested.
- OWASP Argon2id minimum baseline is **19 MiB, 2 iterations, parallelism 1**, but measure memory and concurrent requests on free backend before choosing settings. Source: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html .
- OTP: 5-minute expiration, single use, HMAC/hash verifier, no plaintext OTP logs; per-IP/account caps + time delays; resilience to resend and replay; never reveal account existence via password-reset responses. CSRF/origin source: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html .
- **Phone SMS:** the single allowed paid exception. Implement `SmsSender` with a deterministic mock for development, but real credentials only after explicit account configuration; never accidentally incur SMS spend during tests. Firebase SMS via Spark is not assumed free. Source: https://firebase.google.com/docs/auth/faq-and-troubleshooting .

### Email delivery caveat (newly identified)

- Brevo offers **300 sends/day free**, HTTPS transactional API; must verify sender before sending. Source: https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan and https://developers.brevo.com/docs/send-a-transactional-email .
- **Important:** Brevo warns that `@gmail.com`/free-address sender domains cannot be properly authenticated and are often rewritten/rejected/filtered. It recommends an authenticated sender domain, which may not be available under this project's absolute ₹0 constraint. Sources: https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC and https://help.brevo.com/hc/en-us/articles/17378397412626-Getting-started-with-Email-deliverability .
- Thus build `EmailSender` adapter with `mock` and `brevo` implementations. **Mock is marked local/development only** and must not silently be used for public invitations/verification. Before deployment validate real inbox delivery and sender authorization; if unavailable at ₹0, keep invite/email authentication demonstration limited and clearly mark unresolved instead of claiming success.

---

## 5. Database design and consistency

- **Mongoose schemas:** users; authIdentities; sessions; verificationChallenges; interviews; interviewEvents; questions; responses; codeSnapshots; evaluations; usagePeriods; usageLedger; plans; subscriptions; paymentEvents; invitations; integrityIncidents; adminAuditLogs; providerUsage; systemSettings.
- **Indexes:** unique normalised email for users; unique `(provider,subject)` for identities; unique hashed refresh token/session ID; unique `(userId,periodKey)` for usage; unique `(interviewId,sequence)` for interview events; unique `(provider,eventId)` for payments; unique invitation tokenHash; `(userId,startedAt)` for interview history. TTL indexes on verifications/invites/expired short-lived telemetry where policy allows, **not** on event audit that must persist.
- **Atomic quota model:** `usagePeriods` holds current available/committed/reserved counts and bounded reservation summary. Mongo's atomic single-document conditional update is sufficient to ensure one Free user cannot reserve 2 credits. Append an audit record with idempotency key; repair/reconciliation tool checks the authoritative document. If using multi-document transactions later, verify Atlas tier support/test operational behavior before depending on it. Source: https://www.mongodb.com/docs/manual/core/write-operations-atomicity/ .
- **Deadline:** server timestamps and revision checks; client does not set remaining minutes. Interview turns have immutable logical ID to dedupe network retries.
- **Repairability:** admin-triggered adjustments are separate ledger events with actor and reason; never overwrite a user's credit balance without history.
- **No unnecessary media:** default stores text/code/metadata, not raw microphone/video. Retention jobs use admin-triggered/on-read housekeeping on free infra instead of assuming always-on cron jobs.

---

## 6. SaaS access and payments

- Plan prices and counts: Free 1×15; ₹250×10; ₹500×25; ₹1000×50; VIP count-unlimited, same premium features on all paid tiers. Separate access from invoices.
- **Sandbox billing** until vendor finalized and live capacity measured. Provider-agnostic `BillingProvider` implemented with a `MockBillingProvider` and one future real sandbox adapter (Razorpay/Cashfree candidate, **not chosen**). Never enable live keys or charge a user.
- Signed webhook raw body validation; duplicate/out-of-order delivery tolerant; idempotent event inbox and subscription transitions. Official testing and webhook docs: https://razorpay.com/docs/api/payments/subscriptions/create-plan/ and https://razorpay.com/blog/payment-gateway-webhooks-india .
- All premium APIs recheck entitlements against server state. Free user's aggregate score stays accessible, premium report DTO is withheld. Account-data export/delete never behind paywall.
- VIP invitation: strong random token, email-bound, short expiry, single redemption, requires authenticated verified email; admin can revoke/expire, action logged. Unlimited means **no per-user count cap**, not free provider infinite capacity.

---

## 7. Trust boundaries and security research

- **Candidate-controlled material** includes answers, resume/JD text, GitHub README and code; treat as DATA, not instructions that modify admin logic, scoring policy or prompts.
- Anti-cheat browser signals are untrusted; never use an LLM to decide guilt or terminate directly. Contextual debounce and manual admin review.
- `ADMIN` privilege comes from persisted server assignment, never frontend or ID token uncontrolled claims. Require explicit audit reason for quota grants, VIP overrides, suspensions and privacy-sensitive support access.
- Web security: Helmet and CSP tuned for WebGPU/wasm/models; rate limiting, payload size caps, file type and path allowlists, CSRF/origin protections, strict CORS, upload analysis without executing content, no raw tokens in logs. Sources: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html and https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html .
- Admin read of user transcripts/resumes is NOT the default. Justified support access must be time-limited, audited and restricted; passwords, OTPs, refresh tokens and full raw camera recordings are never visible.
- **Threat modeling scenarios:** forged Firebase token, session replay, free-to-paid privilege escalation, concurrent double interview starts, free plan premium detail REST leak, duplicate billing webhooks, quota-free fallback misuse, malicious candidate prompt, resume injecting instructions, blocked browser mic, user hiding full screen and false-positive face events.

---

## 8. Key implementation traps to avoid

1. Never carry the prototype's **loopback-only unauthenticated** `/api/metrics` or `metrics.csv` endpoints directly into public deployment. Admin-only endpoints require auth and payload sanitization.
2. Never reuse the prototype's **server-start local request cap** as a real daily quota; it resets on Render restarts. Persist provider budget state or reconcile it using the provider's authoritative usage/rate headers.
3. Don't auto-retry AI requests after user barge-in and accidentally speak stale replies.
4. Don't claim Cloudflare fallback always works with Qwen merely because model listing exists; verify Free eligibility and token cost.
5. Don't assume all Groq JSON schema modes are strict on Qwen. Enforce schema and errors locally.
6. Don't make backend cookies rely on third-party settings without browser tests.
7. Don't assume free email sender domains meet deliverability requirements; test before production auth claims.
8. Don't use MongoDB Atlas storage as free unlimited transcript archive.
9. Don't state paid plans can deliver 50×60-minute sessions on unpaid inference; it's a sandbox plan proposal.
10. Don't claim code correctness tests were executed; current coding interview editor is static evaluation only.

---

## 9. Source register (primary official documents; reviewed Nov 22, 2026)

| ID | Source | What it grounds |
|---|---|---|
| S01 | https://console.groq.com/docs/rate-limits | Qwen account limits; org-level quotas; response headers |
| S02 | https://console.groq.com/docs/model/qwen/qwen3.8-27b | Exact model existence, capabilities |
| S03 | https://console.groq.com/docs/structured-outputs | Strict vs best-effort JSON/JSON object behavior |
| S04 | https://console.groq.com/docs/your-data | Data retention / Zero Data Retention |
| S05 | https://developers.cloudflare.com/workers-ai/platform/pricing/ | 10k neurons/day + pricing |
| S06 | https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/ | Exact Cloudflare model ID and neuron/token rate |
| S07 | https://developers.cloudflare.com/workers-ai/platform/data-usage/ | AI data usage/no-training declaration |
| S08 | https://developers.cloudflare.com/pages/functions/pricing/ | Pages Functions count as Workers requests |
| S09 | https://render.com/docs/free | Cold start, ephemeral disk, SMTP, overages |
| S10 | https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ | Atlas Free limitations |
| S11 | https://firebase.google.com/docs/auth/admin/verify-id-tokens | Firebase ID token verification on backend |
| S12 | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html | Argon2id baseline |
| S13 | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | CSRF and cookie mitigations |
| S14 | https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan | Brevo daily limit |
| S15 | https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC | Sender domain caveat |
| S16 | https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition | STT compatibility/remote recognition |
| S17 | https://developers.cloudflare.com/turnstile/get-started/ | Free bot protection/test controls |
| S18 | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api | Public GitHub API budget |
| S19 | https://razorpay.com/docs/api/payments/subscriptions/create-plan/ | Subscription sandbox pathway |
| S20 | https://www.mongodb.com/docs/manual/core/write-operations-atomicity/ | Conditional atomic quota updates |

**Source integrity note:** Published rate limits, prices, SDK compatibility, permissions and provider privacy settings can change; current service account dashboards and deployed tests outrank this static research snapshot. No external service was provisioned or charged in preparing this research.
