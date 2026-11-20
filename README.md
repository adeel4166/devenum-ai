# Devenum AI — Autonomous Virtual Software House

Monorepo with four apps:

- `backend/` — Express + Prisma + MySQL REST API (port **4200**)
- `portal/` — Next.js (App Router) + Tailwind management portal (port **4201**)
- `worker/` — execution worker (PM2 `devenum-worker`): runs READY tasks through Claude Code CLI in git workspaces
- `bot/` — Discord Command Center (PM2 `devenum-bot`)

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
- All agents default to `CLAUDE_CODE`. An agent switched to `GEMINI_API` in the Portal uses Gemini only while `geminiApiKey` is set; otherwise the worker falls back to Claude Code.
- The Gemini API key is stored server-side in the `Setting` table and returned masked.

## Upgrading from v1 to v2

v2 adds `User.isActive` (default `true`), so run a new migration against your existing database:

```bash
cd backend
npx prisma migrate dev --name v2_user_active
npm run dev
```

The Claude CLI setting key is now `claudeCliEnabled` (previously `claudeCliMode`); re-save it once on the Settings page.

## Phase 3: execution worker and Discord bot

Schema changes are additive. Apply them with `cd backend && npx prisma db push` (this project uses `db push`, not migration files), then run `npm run agents:claude-code` once to set every agent's provider to Claude Code.

### Worker (`worker/`)

- Every 5 s it claims the highest-priority `READY` task whose agent is `AVAILABLE` and whose dependencies are `DONE`. It respects `globalPaused`, `maxConcurrentAgents` and `claudeCliEnabled`, and runs one task per project workspace at a time.
- Workspaces live in `/opt/devenum-ai/workspaces/<project.slug>`, with branch `main` and task branches `task/<taskId>`. When the worker runs as root, git and `claude -p` run as `devenum` via `su - devenum -c`, and the prompt is passed on stdin.
- Run timeout is `min(manifest.timeoutSeconds, Setting.maxRunTimeoutSeconds)`. On timeout or pause, the whole process session is killed.
- When a run finishes, the AgentRun is set to `SUCCEEDED`/`FAILED`, the task moves to `AWAITING_APPROVAL`, and a `PENDING` proposal is created with the summary, changed files, risk, rollback plan and validation plan. Runs that fail with no changes go to `BLOCKED`; cancelled runs go back to `READY`.
- Merge hook: `APPROVED` proposals that have a `branchName` are merged into `main` with `--no-ff`. The task becomes `DONE` and a `TASK_BRANCH_MERGED` audit event is written. On a merge conflict the merge is aborted, the task becomes `BLOCKED` and `mergeError` is recorded.
- If a proposal is rejected or changes are requested, set the task back to `READY`. The next run continues on the same branch and gets the CEO's comments in its prompt.

### Bot (`bot/`)

Slash commands: `/project-create`, `/task-add`, `/status`, `/approvals`. New `PENDING` proposals are posted to `DISCORD_APPROVAL_CHANNEL_ID` with Approve/Reject buttons; Reject opens a modal for the reason. The bot talks to the backend's `/api/bot/*` endpoints using `BOT_SERVICE_TOKEN`. Decisions are attributed to the CEO user and audited with `actorType: DISCORD_CEO`. Only the users listed in `DISCORD_ALLOWED_USER_IDS` can act; if the list is empty, only server Administrators can. `/status` is open to everyone.

### Run

```bash
cd worker && npm install && npm run build
cd ../bot && npm install && npm run build      # fill in bot/.env first
cd .. && pm2 start ecosystem.config.js --only devenum-worker,devenum-bot && pm2 save
```
