# RocketMoney — Test Plan (M5, issue #9 deliverable)

IEEE-style system test plan. Automated suites: `npm test` (unit, no DB) and
`npm run test:integration` (DynamoDB Local). Entry criteria: M4 slices merged.
Exit criteria: all TCs pass locally and in CI (#10); failures file follow-up issues.

## TC matrix

| TC-ID | Requirement(s) | Objective | Preconditions | Steps | Expected |
|---|---|---|---|---|---|
| TC-ROOM-01 | ROOM-001/002/003 | Create + invite + join | Owner exists | Create room, generate token, join as second user | 1 room, 2 ACTIVE memberships, `RoomMemberJoined` outbox rows |
| TC-ROOM-02 | ROOM-003, NFR-008 | Double join idempotent | Room + multi-use token | Join twice same user | Second returns `alreadyMember`, still 1 membership |
| TC-ROOM-03 | ROOM-003, NFR-008 | Concurrent single-use join race | Room + 1-use token | 2 users join simultaneously | Exactly 1 membership; loser 404/409 |
| TC-ROOM-04 | ROOM-004, SEC-002 | Role enforcement matrix | Owner + member + stranger | Member invites (403), stranger reads (404), owner invites (201) | Matrix holds |
| TC-ROOM-05 | ROOM-005 | Transfer-or-exit | Owner + member | Transfer without successor (400); by member (400); valid transfer | Roles flip atomically; old owner loses caps |
| TC-ROOM-06 | ROOM-006/010 | Owner deleted → freeze → claim | Room + member, signed `user.deleted` | Deliver deletion webhook | User DELETED, room FROZEN, writes 409, member claims ownership |
| TC-ROOM-07 | ROOM-007 | Removal gate | Debtor with balance | Remove debtor (409); settle; remove (200) | Gate follows real balances |
| TC-ROOM-08 | ROOM-009, NFR-003 | Webhook idempotency | Valid signed events | created→updated→replay→bad signature | created/updated/duplicate-ignored/401 |
| TC-EXP-01 | EXP-001 | Equal split math | 5 members | ₹1,000 expense, payer fronts | Four ₹200 receivables; payer net −800 |
| TC-EXP-02 | EXP-002/005 | Immutability + idempotency | Room | Replay same idempotency key; concurrent same-key pair | One row; winner returned to loser |
| TC-EXP-03 | EXP-003/004 | Settlement lifecycle | Debt exists | Request → complete → complete again | Balances zero; second complete safe |
| TC-EXP-04 | NFR-008 | Expense ∥ settlement race | Debt + second expense | Run concurrently with client retry | Rebuild matches materialized |
| TC-EXP-05 | EXP-006 | Log rebuild | Mixed history | Replay log, compare | `match: true`, zero mismatches |
| TC-SUB-01 | FR-001/002 | CSV import + detection | 3 monthly Netflix rows | Import twice; analyze | 3 imported then 3 skipped; 1 recurring found; `fallbackUsed` true with RTT |
| TC-SUB-02 | FR-007 | Share invariant | Sub + 2 rooms | Link to room 1 (200); link to room 2 (400); member reads | Single link enforced |
| TC-SUB-03 | FR-003 | Renewal scan | Sub due in 24h | Scan | `SubscriptionRenewalApproaching` emitted; webhook receiver got payload |
| TC-SUB-04 | FR-004/006 | Guides + concierge | Subs | Known guide valid; unknown unsupported; short auth rejected; full flow pending→cancelled | As specified |
| TC-SUB-05 | FR-005/008 | Reports + dashboard | Active subs | CSV has no `@`/ids; PDF magic `%PDF`; dashboard sums actives | Anonymity asserted |
| TC-SEC-01 | SEC-001/003 | Secret hygiene | Repo + running app | Secret-scan CI; boot without env names only | No secrets in git/logs/DB |
| TC-NFR-01 | NFR-005/006 | Fail-fast + shutdown | — | Boot w/o env (exit 1); SIGTERM (exit 0 drained) | Covered by M0 smoke |
| TC-NFR-02 | NFR-003/004 | Outbox + locks | — | Double-claim single winner; lock contention 409; stale-holder release safe | Covered in rooms suite |
| TC-AUTH-01 | SEC-002 | Session verification | JWKS endpoint | Valid JWT accepted; tampered 401; no seam without flag | New in #18 |
| TC-WORK-01 | NFR-003 | Worker delivery | Due renewal + webhook receiver | Poll once | Event DONE; receiver got exactly one payload |
| TC-NFR-03 | NFR-002 | Dashboard budget | 10k transactions | Seed + measure dashboard p95 | < 2.0 s (M6 perf gate; recorded here) |

## Concurrency matrix (must-pass set)
Double join · double settle-complete · duplicate webhook delivery · duplicate outbox claim ·
lock contention + expiry · worker crash between claim and done (event stays CLAIMED → lease
recovery re-drives; documented behavior, tested by re-poll).

## Non-functional / failure testing
Fail-fast table (each missing dep → distinct exit-1 diagnostic) · graceful-shutdown drain ·
webhook-down fallback (log, no throw) · SkillOpt-down fallback (baseline + flag).

## Traceability close-out
TC-ROOM-* → ROOM-001…010 (#6) · TC-EXP-* → EXP-001…007 (#7) · TC-SUB-* → FR-001…008 (#8) ·
TC-SEC/NFR-* → cross-cutting (#4/#5/#10/#18). Every requirement maps to ≥1 TC above.
