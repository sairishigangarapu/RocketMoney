# RocketMoney — Requirements Baseline (M1)

Status: **BASELINED 2026-09-27** (issue #2). Extends Lab 1 (FR-001–005, NFR-001–002, kept verbatim
in intent, tightened for testability). Every requirement is atomic, measurable, and maps to one
implementing issue (#3–#8 per `docs/issues/BASELINE-ISSUES.md`), one ADR, and (in M5) test cases.

Conventions: priority P0 (MVP blocker) / P1 (MVP expected) / P2 (post-MVP). "User" = WorkOS-
authenticated application user. Money examples use ₹; currency handling is M3 detail.

## FR — Personal subscription core (Lab 1 lineage)

| ID | Description | Pri | Acceptance criteria | Issue | ADR |
|----|-------------|-----|---------------------|-------|-----|
| FR-001 | Detect recurring billing patterns from imported transactions and project total monthly subscription expenditure. | P0 | Recurring merchant billed ≥2 consecutive cycles is flagged with renewal date; one-off payment of same amount is not flagged. | #6 | ADR-001 |
| FR-002 | Connect bank accounts via secure read-only API integration and import transaction history automatically. | P0 | Sync populates normalized transactions; app never requests or holds write-scope credentials. | #6 | ADR-001 |
| FR-003 | Send renewal alert (push/email) at least 72 hours before an identified renewal. | P0 | Alert timestamp is ≥72h before renewal; no alert after charge. | #6 | ADR-005 |
| FR-004 | Provide step-by-step cancellation guide or direct cancellation-portal link per identified subscription. | P1 | Every supported provider row returns a valid guide/link; unknown provider returns explicit "unsupported" state, never a dead link. | #6 | ADR-001 |
| FR-005 | Export anonymized aggregate monthly burn-rate reports in CSV and PDF. | P2 | Export succeeds; report contains zero PII, passwords, or tokens (verified by test scan). | #6 | ADR-001 |
| FR-006 | Offer authorized concierge cancellation: explicit user authorization → provider workflow → Pending → Cancelled on provider confirmation. | P2 | No concierge action without recorded authorization; status transitions are auditable. | #6 | ADR-005 |
| FR-007 | Distinguish personal subscriptions (`roomId` null) from shared subscriptions (one row linked to exactly one room, never duplicated per member). | P0 | Shared subscription has exactly one row; member views resolve through room membership. | #6 | ADR-007 |
| FR-008 | Render personal and per-room burn-rate dashboards. | P0 | Dashboard figures equal the sum of active subscription rows + member share rows within rounding of ₹1. | #6 | ADR-001 |
| FR-009 | Sign in exclusively via WorkOS; no local passwords. | P0 | No password field, hash, or credential column exists anywhere in code or schema. | #4 | ADR-002 |

## ROOM — Shared rooms, membership, identity sync

| ID | Description | Pri | Acceptance criteria | Issue | ADR |
|----|-------------|-----|---------------------|-------|-----|
| ROOM-001 | Owner creates a room (name, settings); creator becomes OWNER. | P0 | Creator holds OWNER role; room has exactly one owner at all times. | #4 | ADR-007 |
| ROOM-002 | Owner generates invitation tokens that are opaque, expiring, and revocable (single- or multi-use). | P0 | Token leaks no PII/room data; expired/revoked/over-capacity tokens are rejected with distinct errors. | #4 | ADR-007 |
| ROOM-003 | Invited user joins via link: WorkOS auth → token validation → membership write → `RoomMemberJoined` event. Join is idempotent and race-safe. | P0 | Double-click/double-join yields one membership; two simultaneous joins yield one membership + one 409. | #4 | ADR-004/005 |
| ROOM-004 | Enforce OWNER vs MEMBER caps server-side (owner: manage room/members/splits/invites/transfers/cancellation; member: view, record/pay, settle). | P0 | Every room/resource operation checks membership + role; unauthorized call returns 403 even with valid session. | #4 | ADR-007 |
| ROOM-005 | Owner exit requires designating a successor first; exit without successor is rejected (4xx). | P0 | No room is ever left with zero owners through the exit path. | #4 | ADR-010 |
| ROOM-006 | WorkOS-side owner disappearance with no successor freezes the room: reads allowed; expense/settlement/invite writes rejected; members notified via outbox event. | P0 | Frozen room rejects writes with distinct error; unfreezes on successor assignment with history intact. | #4 | ADR-010 |
| ROOM-007 | Member removal is owner-only and blocked while the member's net balance is nonzero. | P1 | Removal with unsettled balance returns 409; removal emits `RoomMemberRemoved`. | #4 | ADR-007/008 |
| ROOM-008 | Every room mutation appends an activity entry (actor, action, timestamp). | P1 | Join/expense/settlement/transfer/removal/freeze each produce a retrievable entry. | #4 | ADR-007 |
| ROOM-009 | WorkOS `user.created/updated/deleted` events project to DynamoDB users keyed by `workosUserId`, idempotently; email is never the join key. | P0 | Replayed/duplicated events create no duplicates and corrupt no state. | #4 | ADR-010 |
| ROOM-010 | Deactivation suspends access but retains domain rows; deletion follows the transfer-or-freeze rule (ROOM-005/006), never blind hard-delete. | P0 | No dangling references to removed users in rooms, subscriptions, expenses, or settlements. | #4 | ADR-010 |

## EXP — Expense splitting and settlement (MVP: equal split only)

| ID | Description | Pri | Acceptance criteria | Issue | ADR |
|----|-------------|-----|---------------------|-------|-----|
| EXP-001 | Create expense with amount, payer, participants, and equal split. | P0 | ₹1,000 across 5 members yields four ₹200 receivables against the payer. | #5 | ADR-008 |
| EXP-002 | Expense rows are immutable once written; corrections are new reversing entries, never edits. | P0 | Update/delete API on expenses does not exist or returns 405. | #5 | ADR-008 |
| EXP-003 | Pairwise balances materialize atomically with each expense/settlement under the room lock (domain write + balance updates + outbox row in one transaction). | P0 | Concurrent expense + settlement leave balances equal to replaying the log. | #5 | ADR-003/004/005 |
| EXP-004 | Settlement lifecycle (requested → completed, with history) decrements the debtor→creditor balance. | P0 | Completed settlement reduces the pair balance exactly; history lists all settlements. | #5 | ADR-008 |
| EXP-005 | Expense/settlement creation accepts a client idempotency key; retries never double-post. | P0 | Same key replayed returns the original result without new ledger rows. | #5 | ADR-005 |
| EXP-006 | Balances are rebuildable by replaying the expense/settlement log. | P1 | Rebuild job output matches materialized balances exactly. | #5 | ADR-008 |
| EXP-007 | Members can view their share, room balances, and settlement history. | P0 | Non-member access returns 403/404 without leaking amounts. | #5 | ADR-007 |

## SEC — Security

| ID | Description | Pri | Acceptance criteria | Issue | ADR |
|----|-------------|-----|---------------------|-------|-----|
| SEC-001 | Store no passwords, auth secrets, raw WorkOS credentials, or raw bank credentials; integration access is tokenized. | P0 | Schema + secret scan in CI finds none; DB dump contains tokens only. | #4 | ADR-002 |
| SEC-002 | Authentication (WorkOS: who) is separate from authorization (RocketMoney + room role: what); valid session alone grants no resource access. | P0 | Automated test matrix of role × operation passes. | #4 | ADR-010 |
| SEC-003 | Log no secrets, tokens, passwords, or unnecessary financial PII; structured fields only. | P0 | Log sample review + CI secret-scan passes. | #4 | ADR-002 |
| SEC-004 | Invitation tokens are random, opaque, and carry no PII. | P0 | Token decodes to nothing; token→room resolution is server-side only. | #4 | ADR-007 |
| SEC-005 | All financial mutations (expense, settlement, transfer, removal, freeze) are audit-logged with actor + timestamp. | P1 | Audit trail covers every EXP/ROOM mutation in test replay. | #5 | ADR-008 |

## NFR — Non-functional

| ID | Description | Pri | Acceptance criteria | Issue | ADR |
|----|-------------|-----|---------------------|-------|-----|
| NFR-001 | Transaction imports parse securely with no cleartext banking credentials anywhere (Lab 1). | P0 | Pen-test/secret-scan passes; only tokenized keys at rest. | #6 | ADR-001 |
| NFR-002 | Dashboard renders monthly burn rate within 2.0 s for ≤10,000 transaction records (Lab 1). | P1 | Measured p95 < 2.0 s under simulated load. | #6 | ADR-001 |
| NFR-003 | Side effects use Transactional Outbox: at-least-once delivery + idempotent consumers; exactly-once never claimed. | P0 | Duplicate delivery and worker-crash tests leave state consistent. | #4 | ADR-005 |
| NFR-004 | Distributed locks are lease-based (10–30 s) with expiry-as-crash-safety; contention fails fast with retry guidance. | P0 | Lock-expiry and contention tests pass; no deadlock observed. | #4 | ADR-004 |
| NFR-005 | Startup fails fast on invalid/missing mandatory config with named-component diagnostics and non-zero exit. | P0 | Each missing dependency yields a distinct, secret-free error + exit 1 (covered by M0 smoke test). | #4 | ADR-001 |
| NFR-006 | Shutdown is graceful with bounded (≈10 s) drain; overruns log and terminate safely, never silently. | P0 | SIGTERM test exits 0 after draining in-flight work (covered by M0 smoke test). | #4 | ADR-001 |
| NFR-007 | SkillOpt path logs wall-clock RTT + latency (p50/p95) vs deterministic fallback, which always remains available. | P1 | Analysis works with SkillOpt disabled; eval numbers recorded per invocation. | #6 | ADR-006 |
| NFR-008 | System stays consistent under concurrency (simultaneous joins, expense + settlement races). | P0 | M5 concurrency matrix passes. | #7 | ADR-004 |

Out of scope for MVP (tracked, not committed): exact/percentage/custom splits, multi-currency
settlement, native mobile apps, microservices extraction, async-batch SkillOpt.

## Traceability matrix (M1 snapshot; test column fills in M5/#7)

| Requirement | Issue | Component | ADR | Code | Test | Result |
|-------------|-------|-----------|-----|------|------|--------|
| FR-001…009 | #6 (FR-009: #4) | Analysis/Subscriptions/Identity | ADR-001/002 | M4 | TC-* (M5) | — |
| ROOM-001…010 | #4 | Rooms/Identity Sync | ADR-007/010 (+004/005) | M4 | TC-ROOM-* (M5) | — |
| EXP-001…007 | #5 | Expense/Split | ADR-008 (+003/004/005) | M4 | TC-EXP-* (M5) | — |
| SEC-001…005 | #4 (SEC-005: #5) | API boundary/Rooms/Ledger | ADR-002/007/008/010 | M4 | TC-SEC-* (M5) | — |
| NFR-001…008 | as tabled | Cross-cutting | ADR-001/004/005/006 | M0/M4 | TC-NFR-* (M5; NFR-005/006 already M0 smoke) | — |

M1 gate: this document reviewed and baselined. Changes after baseline require issue + ADR
amendment, not silent edits.
