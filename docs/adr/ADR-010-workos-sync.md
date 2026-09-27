# ADR-010 — WorkOS ↔ DynamoDB User Synchronization

- Status: Accepted (2026-09-27; Q1: events+webhooks; Q2: transfer-or-freeze).
- Context: WorkOS owns identity; RocketMoney owns application state. A local projection is needed
  so domain rows (rooms, subscriptions, expenses, balances) can reference users efficiently.
- Decision: Webhook endpoint consumes WorkOS Events (`user.created/updated/deleted`):
  signature-verify → dedupe on WorkOS event ID (`idempotency` table, TTL) → apply to `users`
  projection keyed by `workosUserId` (conditional put on create; version-guarded update).
  Delivery semantics assumed: at-least-once, unordered; handler is idempotent and retry-safe, with
  poll/replay recovery and DLQ for poison events.
- Lifecycle (Q2, binding): `deleted/deactivated` never hard-deletes while domain relationships
  exist. Owner exit via API REQUIRES naming a successor (else 4xx). WorkOS-side disappearance
  with no successor → room `FROZEN` + `RoomFrozen` outbox event + member notifications; invites
  revoked; balances/settlements/history retained; unfreeze on successor assignment.
  Deactivate-vs-delete retention windows are M3 detailed-design items.
- Alternatives: Polling-only sync (rejected: latency/complexity); blind hard-delete (rejected:
  destroys referential integrity); email-keyed reconciliation (rejected: unstable key).
- Rationale: Stable `workosUserId` key + idempotent handler + explicit lifecycle = integrity under
  retries and deletions.
- Consequences: AuthN≠AuthZ enforced per operation; M5 tests duplicate-event delivery and
  owner-disappearance paths.
