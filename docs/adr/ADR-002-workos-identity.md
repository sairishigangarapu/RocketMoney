# ADR-002 — WorkOS for Identity

- Status: Accepted (2026-09-27).
- Context: Brief forbids custom password/credential storage; identity must be delegated.
- Decision: WorkOS is the Identity Source of Truth. App performs session/token verification at the
  API boundary and maps to the DynamoDB application projection. No passwords, auth secrets, or raw
  WorkOS credentials are stored.
- Alternatives: Custom auth (rejected: explicitly out of scope, security liability); other IdPs
  (rejected: brief mandates WorkOS).
- Rationale: Delegates credential lifecycle, rotation, and compliance to the IdP; app keeps only
  `workosUserId` + domain data.
- Consequences: WorkOS availability is a startup dependency (fail-fast); AuthN ≠ AuthZ is enforced
  in every service (see ADR-010).
