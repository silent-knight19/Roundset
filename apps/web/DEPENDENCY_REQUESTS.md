# Frontend Dependency Requests — Task P1-FE-01

**Date:** 2026-11-22  
**Agent:** Frontend Implementation Engineer (Agent B)  
**Branch:** `agent/frontend`  
**Target Lockfile Owner:** Agent A / Integrator (`P1-INT-01`)

---

## 1. Summary of Dependencies Added to `apps/web/package.json`

Per the architecture brief for **P1-FE-01**, the following exact approved dependencies were added to `apps/web/package.json` and installed locally using `npm install --package-lock=false`:

### Production Dependencies (`dependencies`)

| Package | Version | Purpose |
|---|---|---|
| `@roundset/contracts` | `*` | Monorepo contract schemas and types |
| `react` | `19.3.0` | Core UI library |
| `react-dom` | `19.3.0` | React DOM renderer |
| `react-router-dom` | `7.18.6` | Client-side routing |

### Development Dependencies (`devDependencies`)

| Package | Version | Purpose |
|---|---|---|
| `@tailwindcss/vite` | `4.3.5` | Tailwind CSS v4 Vite integration plugin |
| `@testing-library/dom` | `10.4.2` | DOM testing utilities |
| `@testing-library/react` | `16.3.3` | React 19 testing library utilities |
| `@types/node` | `^22.13.4` | Node.js TypeScript typings |
| `@types/react` | `19.3.0` | React 19 TypeScript typings |
| `@types/react-dom` | `19.3.0` | React DOM 19 TypeScript typings |
| `@vitejs/plugin-react` | `6.3.0` | Vite React compiler/refresh plugin |
| `jsdom` | `30.0.1` | DOM environment for Vitest |
| `tailwindcss` | `4.3.5` | Utility-first CSS framework (v4 engine) |
| `typescript` | `^5.7.3` | Static typechecking compiler |

---

## 2. Lockfile Integrity and Integrator Action

- **Root `package-lock.json` status on `agent/frontend`:** UNTOUCHED.
- As required by `AGENTS.md` and `docs/plan/PARALLEL_AGENT_EXECUTION_PLAN_v1.md`, Agent B does not modify the root lockfile.
- **Action for Integrator (`P1-INT-01`):**
  When merging `agent/frontend` into `main`, execute:
  ```bash
  npm install
  ```
  to reconcile root `package-lock.json`. Once reconciled, `npm ci` will be reproducible in CI.
