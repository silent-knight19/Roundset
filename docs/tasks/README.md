# Atomic Task Specifications

This directory stores architect-authored atomic task specifications guiding implementation agents.

## Lifecycle

1. **BACKLOG**: Task drafted and pending authorization.
2. **READY**: Authorized for implementation by assigned agent.
3. **IMPLEMENTED**: Agent has completed code, tests, and evidence handoff.
4. **REVIEWED**: Independent code review performed by Principal Architect.
5. **ACCEPTED**: Approved by Principal Architect and merged by project owner.

Coding agents must only implement tasks in **READY** status within their assigned scope.
