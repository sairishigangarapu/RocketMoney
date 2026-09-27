# ADR-001 — Layered Architecture with Modular Components (Evolved)

- Status: Accepted (2026-09-27). Supersedes Lab 3 §2 as the deployable baseline.
- Context: Lab 3 defined a layered architecture with modular business components. New mandates
  (Rooms, WorkOS, DynamoDB, outbox, locks, SkillOpt, brutalist UI) must land without a rewrite.
- Decision: Keep the layered modular monolith (Fastify JS backend + React TSX frontend).
  Internal async behaviour via Transactional Outbox + workers. Stack (Q7): Node+Fastify backend
  optimised for short OLTP transactions; React+TypeScript frontend.
- Alternatives: Microservices (rejected: ops cost, no independent-scaling evidence); EDA-as-primary
  (rejected: kept as internal mechanism instead).
- Rationale: Small team, single primary store, Lab 3 traceability preserved; services evolve
  independently as modules first.
- Consequences: Must enforce module boundaries via repository interfaces + adapters; extraction to
  services later stays possible.
