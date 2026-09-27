# ADR-008 — Expense / Ledger Model

- Status: Accepted (2026-09-27; Q4: equal-split MVP; Q5: hybrid ledger).
- Context: Rooms need Splitwise-style tracking (expenses, shares, balances, settlements) that stays
  consistent under concurrency and auditable afterwards.
- Decision: HYBRID — (a) append-only immutable `expenses`/`settlements` rows as the audit trail and
  rebuild source; (b) materialized pairwise `balances` rows (`debtor#creditor`) updated atomically
  with each expense/settlement inside the room lock + TransactWrite bundle. MVP split method is
  EQUAL ONLY (₹1,000/5 → four ₹200 receivables when one member pays all). Exact/percentage/custom
  are deferred post-MVP issues.
- Alternatives: Pure computed-on-read (rejected: race-prone, expensive at scale); pure event-replay
  (rejected: read cost); all-split-strategies-now (rejected: scope).
- Rationale: Fast consistent reads + auditability + rebuild path; minimal MVP surface.
- Consequences: Settlement correctness and double-settle concurrency tests are M5 gates; new split
  strategies must preserve the ledger invariant.
