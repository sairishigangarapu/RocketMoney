# RocketMoney — Personal Subscription & Shared Expense Auditor

Rooms-based subscription auditing: track personal subscriptions, share them in Rooms,
split expenses equally, settle balances, get renewal alerts, and export anonymized reports.

**Stack:** Fastify JS backend (OLTP-first) + React TSX Brutalist frontend, DynamoDB
multi-table, WorkOS identity. Full architecture: `docs/ARCHITECTURE.md`; decisions:
`docs/DECISIONS.md` + `docs/adr/`; requirements: `docs/REQUIREMENTS.md`; detailed DB
design: `docs/DYNAMODB-DESIGN.md`; test plan: `docs/TEST-PLAN.md`.

## Run locally (no AWS account, no real keys)

Prereqs: Node 20+, and **either** Docker **or** Java 11+ (for DynamoDB Local).

```bash
# 1. Test database (pick one)
docker run -d -p 8000:8000 amazon/dynamodb-local   # official AWS image
# ...or the 1.x jar from https://s3-us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz

# 2. Backend
cd backend && npm install && npm test   # 22 unit, no DB needed
npm run test:integration                # 32 against DynamoDB Local
cat > .env <<'EOF'
WORKOS_API_KEY=dummy
AWS_REGION=ap-south-1
DYNAMODB_TABLE_PREFIX=rm-dev-
DYNAMODB_ENDPOINT=http://localhost:8000
ALLOW_TEST_AUTH=true
EOF
node src/server.js                      # :3000  (load .env first: set -a; source .env; set +a)

# 3. Frontend
cd frontend && npm install && npm run dev
# Set the "Acting as (test)" box to a user id, e.g. u-alice
```

Optional env: `NOTIFY_WEBHOOK_URL` (+`NOTIFY_WEBHOOK_SECRET`) for real alert delivery,
`SKILLOPT_ENDPOINT` for the analysis experiment, `WORKOS_JWKS_URL` for real session
verification, `OUTBOX_POLL_MS` / `SCAN_INTERVAL_MS` for background worker + daily scan.
Without them the app runs on honest fallbacks (log transport, deterministic analysis,
test seam) — see `docs/ARCHITECTURE.md` §6 and `backend/src/auth.js`.

## Production keys checklist (insert before shipping)

- [ ] `WORKOS_API_KEY` (real) + `WORKOS_WEBHOOK_SECRET` (WorkOS dashboard → Webhooks)
- [ ] `WORKOS_JWKS_URL` (WorkOS JWKS endpoint) + remove `ALLOW_TEST_AUTH`
- [ ] IAM credentials scoped to the 12 `rm-*` tables; unset `DYNAMODB_ENDPOINT`
- [ ] `NOTIFY_WEBHOOK_URL` (+ secret) for alert delivery
- [ ] Public HTTPS URL registered as the WorkOS webhook endpoint
- [ ] Daily trigger for the renewal scan (cron/EventBridge → `POST /api/admin/scan-renewals`, or `SCAN_INTERVAL_MS`)
- [ ] `OUTBOX_POLL_MS` worker on (or an external worker) so outbox events get delivered

## Project tracking

Issues #3–#10 (phases) + #14 (frontend) + #18 (this hardening) · Milestones M0–M7 ·
PRs required on `main` with green CI (`ci` workflow: backend unit+integration, frontend build).
