# ADR-007 — Shared Room Domain Model

- Status: Accepted (2026-09-27).
- Context: Rooms are the flagship extension: groups collaborating on a shared subscription or
  recurring expense. Must not blindly copy Splitwise terminology.
- Decision: Room aggregate = id, name, owner (`workosUserId`), members/roles (OWNER/MEMBER),
  subscription link (shared vs personal flag, single subscription row — no duplication),
  cost-allocation config, opaque invitation tokens (expiry, uses, revocation), settings, activity
  log, `status` (ACTIVE/FROZEN). Owner caps vs member caps enforced server-side per
  `docs/ARCHITECTURE.md` §5. Invitation flow: create → token → share link → WorkOS auth →
  validate → conditional membership put → `RoomMemberJoined` outbox event.
- Alternatives: Splitwise-clone schema (rejected: terminology/ownership semantics differ);
  subscription-duplication per member (rejected: divergence risk).
- Rationale: One room owns one shared cost object; membership/role is the AuthZ primitive.
- Consequences: Join races guarded by lock + conditional write; M5 tests double-join and
  concurrent member modification.
