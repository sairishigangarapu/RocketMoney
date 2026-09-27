# M3 — DynamoDB Multi-table Detailed Design (issue #5)

Status: **PROPOSED** (this branch). Freezes the key schemas, GSIs, atomicity bundles, and
protocols that M4 slices implement against. Capacity: **on-demand** for all tables in MVP
(no RCU/WCU tuning until measured load; revisit post-MVP). Region: single-region MVP.

Conventions: `PK` partition key, `SK` sort key. All timestamps ISO-8601 UTC. Money in integer
minor units (`amountMinor`) — no floats anywhere. `v` = optimistic version counter where noted.

## 1. Tables

### `users` — application projection of WorkOS identity (ADR-010)
- PK: `workosUserId` (S). Attributes: `email`, `name`, `status` (`ACTIVE|DEACTIVATED|DELETED`),
  `v`, `createdAt`, `updatedAt`, `lastEventId` (last applied WorkOS event, dedupe guard).
- Patterns: Get profile (GetItem). Create: `PutItem ConditionExpression attribute_not_exists(pk)`
  (ROOM-009 create path). Update: conditional `lastEventId <> :eid AND updatedAt < :ts` so
  out-of-order redelivery never regresses state.
- No GSI in MVP (all access by ID; admin scans are out of scope).

### `rooms` — room aggregate (ADR-007)
- PK: `roomId` (S, `rm_` + ulid). Attributes: `name`, `ownerId` (workosUserId), `status`
  (`ACTIVE|FROZEN`), `subscriptionId` (nullable, at most one), `settings` (map: capacity,
  invite defaults), `v`, `createdAt`, `updatedAt`.
- GSI1 `gsi1-owner`: PK `ownerId`, SK `roomId` → "rooms owned by user".
- Invariant: exactly one owner; ownership change only via transfer flow (§4).

### `memberships` — room membership + role
- PK: `roomId` (S). SK: `workosUserId` (S). Attributes: `role` (`OWNER|MEMBER`), `joinedAt`,
  `status` (`ACTIVE|REMOVED` — tombstone, never physical delete while ledger references exist).
- GSI1 `gsi1-user`: PK `workosUserId`, SK `roomId` → "rooms a user belongs to".
- Join: `PutItem ConditionExpression attribute_not_exists(PK) AND attribute_not_exists(SK)`
  (ROOM-003 race guard; loser gets ConditionalCheckFailed → API maps to 409).
- Remove: conditional update to `REMOVED` + `ConditionExpression netBalance = 0` enforced by the
  service layer pre-check inside the room lock (ROOM-007); row retained for audit.

### `subscriptions` — personal or shared (FR-007)
- PK: `subscriptionId` (S). Attributes: `ownerId`, `roomId` (nullable), `provider`,
  `amountMinor`, `currency`, `renewalDate`, `status` (`ACTIVE|CANCELLED|PENDING_CONCIERGE`),
  `providerRef` (guide/portal link), `v`, timestamps.
- GSI1 `gsi1-owner`: PK `ownerId`, SK `subscriptionId` → "user's subscriptions".
- GSI2 `gsi2-room`: PK `roomId`, SK `subscriptionId` → "room's subscription" (sparse: only rows
  with `roomId` project into it). Shared-link invariant: update sets `roomId` only if
  `attribute_not_exists(roomId)` (one room per subscription, never duplicated).

### `transactions` — imported bank rows per user
- PK: `workosUserId` (S). SK: `txnId` (S, bank-provided id namespaced by source). Attributes:
  `source` (`CSV|PLAID_SANDBOX|...`), `merchantRaw`, `merchantNorm`, `amountMinor`, `currency`,
  `bookedAt`, `importBatchId`, timestamps.
- Idempotent import: re-import of the same batch is a no-op via `attribute_not_exists` puts
  (NFR-001; raw credentials never present — only `source` + token reference in Account config,
  stored in `users` preferences map or a dedicated `integrations` map attribute).
- Analysis scan: `Query(PK=user)` paged; 10k-row dashboard budget measured in M5 (NFR-002).

### `expenses` — immutable expense log (ADR-008)
- PK: `roomId` (S). SK: `expenseId` (S, `ex_` + ulid). Attributes: `amountMinor`, `currency`,
  `payerId`, `participants` (L of workosUserIds, includes payer), `method` (`EQUAL` — MVP only),
  `shares` (M: participant → shareMinor, precomputed, sum == amountMinor; remainder paise go to
  payer — deterministic rule), `idempotencyKey`, `createdBy`, `createdAt`. No updates/deletes
  (EXP-002; API has no such routes).
- GSI1 `gsi1-idem`: PK `idempotencyKey` → duplicate-submit lookup (EXP-005 fast path).

### `balances` — materialized pairwise balances (ADR-008)
- PK: `roomId` (S). SK: `pairKey` = `debtorId + "#" + creditorId` with canonical ordering
  (lexicographically smaller first + sign convention: positive value means first owes second —
  documented once in code, tested by TC-EXP rebuild). Attributes: `balanceMinor` (N, signed),
  `v` (fencing), `updatedAt`.
- Updated only inside the room lock within the same TransactWrite as the expense/settlement row
  (EXP-003). Reads are single `Query(PK=room)`; per-member netting is presentation logic.

### `settlements` — settlement lifecycle (EXP-004)
- PK: `roomId` (S). SK: `settlementId` (S). Attributes: `fromId`, `toId`, `amountMinor`,
  `status` (`REQUESTED|COMPLETED|REJECTED`), `idempotencyKey`, timestamps.
- Transition guard: `COMPLETED` only from `REQUESTED` (`ConditionExpression #s = :req`); terminal
  states immutable. GSI1 `gsi1-idem` on `idempotencyKey` (same dedupe pattern as expenses).

### `invitations` — opaque invite tokens (ROOM-002, SEC-004)
- PK: `token` (S, 256-bit CSPRNG, base64url). Attributes: `roomId`, `createdBy`, `maxUses`,
  `useCount` (N), `expiresAt` (N epoch), `revoked` (BOOL), `createdAt`.
- GSI1 `gsi1-room`: PK `roomId` → list/revoke invites per room.
- Redeem (under room lock): single `UpdateItem` with
  `ConditionExpression revoked = :false AND expiresAt > :now AND useCount < maxUses
   AND attribute_exists(token)` + `ADD useCount :one` — atomic consume, no race (ROOM-003).

### `outbox` — transactional outbox rows (ADR-005)
- PK: `eventId` (S). Attributes: `aggregateType`, `aggregateId`, `type` (event catalogue,
  ARCHITECTURE.md §4), `payload` (domain IDs + versions only — no PII beyond IDs),
  `status` (`PENDING|CLAIMED|DONE|DLQ`), `owner` (worker lease id), `nextAttemptAt` (N),
  `attempts` (N), `createdAt`.
- GSI1 `gsi1-due`: PK `status`, SK `nextAttemptAt` → worker poll ("due PENDING").
  Sparse-projected keys only to keep the index small.
- Claim: `UpdateItem ConditionExpression #s = :pending AND nextAttemptAt <= :now`
  → sets `CLAIMED` + owner + lease. Duplicate delivery is normal (NFR-003); consumers dedupe
  via `idempotency` table on `eventId`.

### `locks` — lease locks (ADR-004, NFR-004)
- PK: `lockKey` (S): `LOCK#ROOM#<id>`, `LOCK#SUB#<id>`, `LOCK#OUTBOX#<eventId>`, `LOCK#ANALYSIS#<user>`.
  Attributes: `owner` (S, uuid per holder), `expiry` (N epoch), `v`.
- Acquire: `PutItem ConditionExpression attribute_not_exists(lockKey) OR expiry < :now`.
  Lease 10–30 s per operation class (join 10 s, expense/settle TransactWrite 15 s, analysis 30 s
  with heartbeat). Release verifies `owner` (only holder releases). Crash → expiry; writers
  include `v`/precondition checks so a stale holder's write fails fenced (NFR-004).
- Contention: API returns 409 + `Retry-After` hint; no blocking waits in request path.

### `idempotency` — financial-op + webhook-event dedupe (EXP-005, ROOM-009)
- PK: `key` (S): `op:<clientKey>` or `wh:<workosEventId>`. Attributes: `resultRef`
  (expenseId/settlementId/membership pointer or `applied`), `expiresAt` (N, TTL enabled,
  7 days — long enough for client retries, short enough to bound storage).
- Check-and-set precedes every financial mutation and webhook application.

## 2. Atomicity bundles (TransactWriteItems)

| Flow | Items in one transaction |
|------|--------------------------|
| Expense create | `expenses` Put (cond. idem-key unused) + N `balances` Updates + `outbox` Put + `idempotency` Put |
| Settlement complete | `settlements` Update (cond. REQUESTED) + 1 `balances` Update + `outbox` Put + `idempotency` Put |
| Room join | `memberships` Put (cond. not-exists) + `invitations` useCount consume (separate atomic Update under same room lock; cross-table transaction where supported, else lock-ordered sequence) + `outbox` Put |
| Owner transfer | `rooms` Update (cond. requester is owner AND successor is ACTIVE member) + `memberships` role flips + `outbox` Put |
| Freeze/unfreeze | `rooms` status Update (cond. version) + `outbox` Put |
| Sync apply | `users` conditional Put/Update + `idempotency` Put (`wh:` key) |

Room-scoped multi-step flows (join, transfer) additionally hold `LOCK#ROOM#<id>`; single-aggregate
writes rely on conditions alone. No Sagas in MVP — transaction size stays small (one expense
touches ≤ ~10 balance rows for rooms within capacity limits).

## 3. Hot-partition and size review

- Keys distribute by `roomId` / `workosUserId` — no global monotonic PK, no single hot item
  except very large rooms; room capacity limit (settings, default 20) bounds `balances` fan-out
  and TransactWrite size.
- GSI write amplification accepted (2 sparse GSIs); `gsi1-due` stays small via sparse keys +
  aggressive `DONE` TTL-equivalent cleanup (worker deletes DONE rows older than 24 h).
- Item sizes: all rows < 10 KB by construction (participants capped; payloads carry IDs only).

## 4. Room transfer / freeze protocol (ROOM-005/006)

- Transfer API input: `{successorId}`. Preconditions (all checked under `LOCK#ROOM#<id>`):
  requester role OWNER, successor ACTIVE member, successor ≠ requester. Effects: `rooms.ownerId`
  + membership roles flip atomically (§2). Exit without successor → 4xx, no state change.
- WorkOS delete/deactivate with no successor: sync handler sets `rooms.status=FROZEN` + emits
  `RoomFrozen`; write paths check status first (frozen → 409 `room-frozen`); successor assignment
  (by any remaining member? No — by invitation of a new owner via support path: M4 API allows an
  ACTIVE member to claim ownership of a FROZEN room, emitting `RoomUnfrozen`). Invites revoked
  (`revoked=true` sweep under lock). Balances/settlements/history untouched.

## 5. Analysis + SkillOpt data path (FR-001, NFR-007)

Read path only: `Query transactions(PK=user)` → normalize → baseline detector → optional
SkillOpt adapter call (bounded timeout, sync) → results + `{rttMs, p50/p95 accumulators, fallbackUsed}`
logged per invocation. SkillOpt receives merchant strings + amounts only, never credentials.
Fallback (deterministic) output schema is identical so callers never branch on provider.

## 6. What M4 slices may assume frozen vs open

Frozen here: table list, key shapes, GSIs, bundle membership, lock/lease parameters, idempotency
scheme, transfer/freeze protocol, equal-only + minor-units money rules. Open for M4: handler code,
error-shape details, notification copy, report layouts, exact CloudFormation/Terraform (if any —
DynamoDB Local first), SkillOpt prompt/contract specifics.
