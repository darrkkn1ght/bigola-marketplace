# Big Ola Marketplace — Two-Stage Deployment Guide

This repository supports a **two-stage deployment** using the same codebase, Neon PostgreSQL database, Upstash Redis instance, and BullMQ multi-pipeline disbursement engine:

- **Stage 1 (Free Launch — $0/month):** `bigola-web` (Render Static Site, Free) + `bigola-api` (Render Web Service, Free) + Neon Free PostgreSQL + Upstash Free Redis.
- **Stage 2 (Optional Worker Activation — $7/month):** Add `bigola-worker` as an independent Render Background Worker (`Starter` plan) without changing the database, frontend, or worker code.

---

## Stage 1: Free Launch ($0/month)

Defined in [`render.yaml`](./render.yaml):

1. **`bigola-web`** — Render Static Site (`runtime: static`, `staticPublishPath: apps/web/out`, rewrite `/marketplace/orders/* -> /marketplace/orders/_/index.html`).
2. **`bigola-api`** — Render Web Service (`runtime: node`, `plan: free`, `healthCheckPath: /api/v1/health`).
3. **Neon PostgreSQL (Free)** — Source of truth for orders, reservations, ledger, and disbursement state.
4. **Upstash Redis (Free)** — BullMQ queue (`disbursement-chunks`) + per-account distributed locks & 30.5s cooldowns.

### Safety Rules During Stage 1
- `DISBURSEMENT_ENABLED=false` stays enforced on `bigola-api`.
- Payment approval never triggers transfers automatically; explicit Owner authorization remains mandatory.
- The BullMQ worker is **not** embedded inside `bigola-api`, and no artificial keep-alive pings or unsafe synchronous transfer fallbacks are used.

---

## Stage 2: Adding `bigola-worker` Later ($7/month)

When ready to run persistent background jobs (automated multi-pipeline BullMQ disbursement, startup crash recovery, and order expiry):

### 1. Create the Background Worker in Render
1. Open the Render Dashboard → **New +** → **Background Worker**.
2. Connect the same GitHub repository (`https://github.com/darrkkn1ght/bigola-marketplace`), branch **`main`**.
3. Configure:
   - **Name:** `bigola-worker`
   - **Region:** `Frankfurt` (same region as `bigola-api`)
   - **Runtime:** `Node`
   - **Plan:** `Starter` ($7/month)
   - **Build Command:**
     ```bash
     npm ci --include=dev && npm run build --workspace=@bigola/shared && npm run db:generate --workspace=@bigola/api && npm run build --workspace=@bigola/api
     ```
   - **Start Command:**
     ```bash
     npm run start:worker --workspace=@bigola/api
     ```

### 2. Share the Exact Environment Variables from `bigola-api`
Copy these exact values from `bigola-api` → **Environment** into `bigola-worker` → **Environment**:

```env
NODE_ENV=production
SUPPLIER_PRIMARY_USERNAME=bigola2823
DATABASE_URL=<same Neon pooled URL as bigola-api>
DIRECT_URL=<same Neon direct URL as bigola-api>
REDIS_URL=<same Upstash rediss:// URL as bigola-api>
QUEUE_PREFIX=bigola_mp_prod
SESSION_SECRET=<same SESSION_SECRET as bigola-api>
ENCRYPTION_KEY_HEX=<same ENCRYPTION_KEY_HEX as bigola-api>
SESSION_TTL_HOURS=24
OWNER_REQUIRE_2FA=true
DISBURSEMENT_ENABLED=false
```

> Do **not** deploy a second copy of `bigola-worker`. Only one `bigola-worker` instance should run (it already runs `concurrency: 5`, one pipeline per canonical LagosLife account).

### 3. Verify Worker Heartbeat & Queue Consumption
1. Wait for `bigola-worker` deploy logs to show `"event":"worker_started"` with `queues: ["disbursement-chunks","infra-health","order-expiry"]` and `concurrency: 5`.
2. Open `https://<your-bigola-api-url>/api/v1/health` and confirm:
   - `worker.alive` is `true`
   - `worker.service` is `"bigola-marketplace-worker"`
   - `worker.concurrency` is `5`
   - `disbursementQueue` reports live queue counts.
3. Open `/owner` in `bigola-web` and confirm **Worker & Multi-Pipeline Health** shows the active worker heartbeat.
4. Keep `DISBURSEMENT_ENABLED=false` until you are ready for controlled live sending, then update `DISBURSEMENT_ENABLED=true` on **both** `bigola-api` and `bigola-worker`.
