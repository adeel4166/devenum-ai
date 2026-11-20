# Devenum AI — Autonomous Virtual Software House

Monorepo with two apps:

- `backend/` — Express + Prisma + MySQL REST API (port **4200**)
- `portal/` — Next.js (App Router) + Tailwind management portal (port **4201**)

## Run locally

1. Create the database (MySQL 8+ running locally):

   ```sql
   CREATE DATABASE devenum_ai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

2. Backend:

   ```bash
   cd backend
   npm install
   cp .env.example .env        # edit DATABASE_URL password and set a real JWT_SECRET
   npx prisma migrate dev --name init
   npm run seed
   npm run dev                 # http://localhost:4200
   ```

3. Portal (second terminal):

   ```bash
   cd portal
   npm install
   cp .env.example .env.local
   npm run dev                 # http://localhost:4201
   ```

4. Open http://localhost:4201 and sign in with `ceo@devenum.com` / `Admin@12345`. Change this password before any real use.

## Verify

```bash
cd backend && npm run typecheck
cd portal && npm run typecheck && npm run build
```

## Notes

- Roles: `CEO` can do everything including deciding proposals; `ADMIN` can manage agents/projects/tasks/settings; `AUDITOR` is read-only.
- Every mutation (approvals, agent pause/disable, manifest edits, settings, emergency pause) writes an `AuditEvent`. The API exposes no update/delete for audit data.
- `ProposalStatus` includes an extra `CHANGES_REQUESTED` value so "Request Changes" decisions are represented on the proposal itself.
- QA and Security engineers use `GEMINI_API` as the primary provider (the enum has one value per agent); their manifests note the Gemini + Claude dual-model setup.
- The Gemini API key is stored server-side in the `Setting` table and returned masked.
