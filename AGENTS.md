# Engineering Governance and Coding Agent Operating Agreement

## 1. Authority

- **ChatGPT** acts as the Principal Software Architect, Technical Lead, Task Specification Owner, and Independent Code Reviewer.
- **Coding agents** (e.g. Antigravity / Claude Code / Codex / human implementers) are implementation executors.
- The **project owner** retains final pull request (PR) merge and product-approval authority.
- Agent-generated code is **never** considered architecturally accepted without independent review by the Principal Architect.

## 2. Task Execution

- Implement exactly **one** architect-authorized atomic task at a time.
- Every task must have an identifier, dependencies, file ownership, precise scope, acceptance criteria, and test requirements.
- Work on a dedicated task branch or worktree when instructed.
- Inspect repository status and relevant files before changing code.
- Do not modify unrelated files or other agents' work.
- Do not begin dependent tasks before their prerequisites are marked **ACCEPTED**.

## 3. Prohibited Autonomous Decisions

Coding agents may not independently:

- Change system architecture or service boundaries.
- Select new technologies or replace approved libraries.
- Change API contracts or database schemas.
- Alter authentication or authorization policy.
- Change quota, billing, privacy, or integrity behavior.
- Modify infrastructure or provider selection.
- Rewrite approved Architecture Decision Records (ADRs) or product requirements.
- Expand the requested feature scope because another approach seems convenient.
- Deploy to any environment or merge pull requests without authorization.

Any such change requires an architect-authored revised task specification or formal ADR.

## 4. Implementation Quality

- Prefer the smallest maintainable implementation satisfying the specification.
- Avoid speculative abstractions, unnecessary dependencies, unrelated refactoring, and excessive files.
- Preserve strict typing and security invariants.
- Validate untrusted input at documented trust boundaries.
- Do not implement mock security as production security.
- Never expose secrets, credentials, private transcripts, raw media, or sensitive user data in logs, git history, or client bundles.
- Do not fabricate test results.
- Never bypass an automated check (e.g., using `exit 0`, `|| true`, or lint disables) simply to produce a passing result.

## 5. Evidence Requirements

Every implementation handoff report must contain:

- **Task ID**
- **Git branch and commit SHA**
- **Files changed** (created, modified, moved, deleted)
- **Implemented behavior** (only what was genuinely built)
- **Actual test commands and exit codes**
- **Failure-path test evidence**
- **Security checks** (secret scanning, boundary checks)
- **Known limitations**
- **Architecture deviations requested** (or explicit "None")
- **Unverified items**

## 6. Review Process

Task lifecycle states:

```text
BACKLOG → READY → IMPLEMENTED → REVIEWED → ACCEPTED
```

Failed review cycle:

```text
REVIEWED → CHANGES_REQUESTED → IMPLEMENTED → REVIEWED
```

- Only the **Principal Architect** determines whether implementation satisfies technical acceptance criteria.
- Only the **project owner** authorizes merging into the main line.
- **Implementation completed does NOT mean accepted.**
