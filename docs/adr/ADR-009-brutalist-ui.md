# ADR-009 — Brutalist UI Design System

- Status: Accepted (2026-09-27).
- Context: Brief mandates a deliberate Brutalist frontend, never a generic SaaS dashboard, without
  sacrificing usability.
- Decision: React TSX frontend with a documented token set: hard borders, high contrast, strong
  type scale, flat (minimal radius) blocks/cards/tables for money, explicit destructive/action
  states. Tokens live in `frontend/src/` (M3/M4). Accessibility, readability, responsiveness,
  keyboard nav, and error visibility are release gates, not trade-offs.
- Alternatives: Generic component kit aesthetic (rejected: violates brief).
- Rationale: Financial data needs blunt hierarchy and unmistakable states; tokens keep it
  consistent.
- Consequences: Design-system doc + a11y/keyboard checklist required before M4 UI work merges.
