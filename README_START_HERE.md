# AI Interviewer — Implementation Package v1.0

**Date:** 2026-11-22 · **Status:** Engineering plan/research completed, **coding Phase 1 ready to start**, most application features NOT implemented.

## Read in this order

1. **`AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`** — single principal document: project definition, every feature, free/paid/VIP access, architecture, development phases, acceptance gates and what to build next.
2. **`docs/ENGINEERING_RESEARCH_AND_ADRS.md`** — researched vendor constraints, technical decisions, API/privacy/security tradeoffs, primary official sources and uncertainties.
3. **`docs/API_AND_DATA_CONTRACTS.md`** — planned route contracts, MongoDB collections/indexes, state machine, error codes, quota and permissions.
4. **`docs/PHASE_01_CODING_BRIEF.md`** — first coding task; P1-FND-01 through P1-FND-08, tests, commands and copy-ready agent assignment.
5. **`docs/IMPLEMENTATION_TRACKER.md`** — editable progress checklist; no tasks falsely marked done.
6. `legacy/` — exact prior project product decisions, architecture and Phase-0 handoff (historical baseline; most recent decisions take precedence).
7. `reference-prototypes/` — past voice prototypes and real metrics CSV. Reference only; not production software.

## What is already validated?

- The local **scripted voice POC** was user-tested: Kokoro + Web Speech API + Silero VAD, natural spoken interruptions, positive user feedback.
- Screenshot of that demo showed 2 interruptions and ~1052 ms UI metric, **not live LLM response latency**.
- Groq metrics CSV contains **16 successful Qwen 3.8 27B calls**; 4,690 total tokens and 651.5 ms median API roundtrip for those limited short-turn tests. This does not prove an entire 15-minute interview or reliable scoring.
- Project and engineering planning documents exist. **No real auth, billing, admin, end-to-end session, production deployment, long-term cost guarantee or actual subscription payment is implemented.**

## Rules that cannot be changed silently

- ₹0 project operating cost, only potential paid exception = phone/SMS OTP credits.
- Firebase Google Sign-In **and** custom email/password/OTP.
- Free 1 × 15 min/calendar month, completed aggregate score /10 only, paywall details.
- Paid sandbox ₹250/10, ₹500/25, ₹1000/50 interviews/month, identical premium features.
- Admin VIP no-app-level-count-limit access, still subject to provider capacity.
- Primary voice Kokoro + browser STT + Silero VAD; first primary text model Qwen 3.8 27B on Groq, Cloudflare fallback only if verified.
- Strict camera/mic/fullscreen integrity policy and 15-minute cooldown after termination.
- No live payment gateway decision; test mode only.

## Immediate task

Create a new git repository and execute **`docs/PHASE_01_CODING_BRIEF.md`**. Do not start with additional model testing. Implement foundation, test and checkpoint; then Phase 2 authentication.

## When continuing in a new ChatGPT conversation

> Continue AI Interviewer implementation. Read this package in order, especially `AI_INTERVIEWER_MASTER_ENGINEERING_ROADMAP_v1.md`, `docs/ENGINEERING_RESEARCH_AND_ADRS.md`, `docs/API_AND_DATA_CONTRACTS.md`, and `docs/PHASE_01_CODING_BRIEF.md`. Preserve all decided requirements and the ₹0 policy. **We are at Phase 1 coding; do not return to brainstorming or repeat feasibility prototypes.** Act as principal architect/engineering reviewer, supply specific tasks/acceptance criteria, and review implementation evidence. Be concise in chat; detailed technical work goes into files.

## Versioning policy

Increment the version of the master roadmap + ADR notes after a material product or infrastructure change. Preserve snapshots instead of overwriting historical evidence. Update the implementation tracker only when source code and real test evidence support the new status. Do not label external dependencies as tested merely because their docs exist.
