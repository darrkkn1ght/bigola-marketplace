# Big Ola Virtual Currency Marketplace (`bigola2823`)

Standalone **Next.js (Vercel) + Fastify API (Railway) + Persistent Worker (Railway) + Neon PostgreSQL + Upstash Redis/BullMQ** commerce and distribution platform for **`bigola2823`**.

> **Safety Lock:** `DISBURSEMENT_ENABLED=false` is enforced across API and Worker in Phase 2. No automated LagosLife transfers are enabled.

---

## Cloud Architecture

- **Frontend (`apps/web`) → Vercel (Next.js App Router):** Hosts the Customer Marketplace (`/marketplace`), Partner Portal (`/partner`), and Owner Console (`/owner`). Only receives `NEXT_PUBLIC_API_BASE_URL` — never database, Redis, or session secrets.
- **Backend API (`apps/api/src/server.ts`) → Railway Service #1:** Fastify REST API, RBAC, TOTP 2FA, CSRF, rate limiting, and audit logging. Connects to Neon via **pooled** `DATABASE_URL` and Upstash via TLS `rediss://`.
- **Background Worker (`apps/api/src/worker.ts`) → Railway Service #2:** Persistent BullMQ worker service for `infra-health` and `order-expiry` queues (with `DISBURSEMENT_ENABLED=false` enforced).
- **Database → Neon PostgreSQL:** Separate **dev/staging** branch/database and **production** database.
  - `DATABASE_URL`: Neon pooled (`-pooler`) URL for runtime queries.
  - `DIRECT_URL`: Neon direct (non-pooled) URL for Prisma migrations (`prisma migrate deploy`) and seeding.
- **Queue / Cache → Upstash Redis:** Standard Redis TLS TCP endpoint (`rediss://...`), configured with `maxRetriesPerRequest: null` and `enableReadyCheck: false` for BullMQ blocking commands.
- *(Optional)* `docker-compose.yml` remains available if you ever choose to run local containers, but Docker/WSL are **not required**.

---

## Step-by-Step Cloud Setup

### 1. Create Cloud Accounts & Provision Services
1. **Neon PostgreSQL:** Create a project, then create two separate branches/databases:
   - `bigola_dev` (Development/Staging)
   - `bigola_prod` (Production)
   - Copy both the **Pooled** (`-pooler...`) connection string (`DATABASE_URL`) and **Direct** connection string (`DIRECT_URL`) with `?sslmode=require`.
2. **Upstash Redis:** Create two separate Redis databases:
   - `bigola-redis-dev` (Development/Staging)
   - `bigola-redis-prod` (Production)
   - Copy the **TCP TLS URL** (`rediss://default:...@....upstash.io:6379`), **not** the REST `https://` URL.
3. **Railway:** Create a project linked to your repo with **two services** (both rooted at repo root):
   - **Service 1 (`bigola-api`):** Config file `apps/api/railway.api.toml`
   - **Service 2 (`bigola-worker`):** Config file `apps/api/railway.worker.toml`
4. **Vercel:** Import the repo, set **Root Directory** to `apps/web` (uses `apps/web/vercel.json`).

### 2. Local Testing Against Cloud Dev/Staging (Neon Dev + Upstash Dev)
Run from `c:\Users\HomePC\Documents\bigola-marketplace`:

```powershell
# 1. Create .env from template and fill in your Neon DEV + Upstash DEV URLs
Copy-Item .env.example .env

# 2. Apply Prisma migrations to Neon DEV (uses DIRECT_URL)
npm run db:migrate

# 3. Run idempotent seed twice to verify no duplicates are created
npm run db:seed
npm run db:seed

# 4. Run full cloud integration suite (Neon + Upstash + BullMQ round-trip + RBAC + Audit)
npm run test:cloud
```

### 3. Remote Health Check
```powershell
# Check local API or set API_HEALTH_URL=https://your-railway-api.up.railway.app/api/v1/health
npm run health:remote
```
