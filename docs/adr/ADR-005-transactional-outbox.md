# ADR-005 — Transactional Outbox

- Status: Accepted (2026-09-27).
- Context: Notifications, concierge workflows, reports, and room/expense events must survive
  crashes without distributed transactions across providers.
- Decision: Domain mutation + `outbox` row persisted atomically (TransactWrite); workers claim via
  conditional status flip under lease, publish with retries/backoff, poison → DLQ status + alert.
  Design for at-least-once + idempotent consumers; exactly-once never claimed. Event catalogue in
  `docs/ARCHITECTURE.md` §4.
- Alternatives: Direct publish in-request (rejected: lost effects on crash); broker-first
  (rejected: extra infra before MVP).
- Rationale: Reliability without new infrastructure; dedupe via `idempotency` table + event IDs.
- Consequences: Consumers must be idempotent and retry-safe; M5 must test duplicate delivery and
  worker-crash-mid-publish.
