# Local development (Windows, no Docker)

This guide runs the full app — API, web, and PostgreSQL — on a Windows machine without Docker Desktop, Google OAuth credentials, or a Resend key. If you have Docker, the `docker-compose` route in the [README](../README.md#getting-started) still works; this is the alternative.

Local development mode (`LOCAL_DEV_MODE=true`) changes three things, and only when `NODE_ENV=development`:

- The login page shows an email/password form instead of Google SSO.
- The API starts without Google OAuth credentials.
- Outbound email (threshold alerts, renewal reminders) is logged and skipped instead of sent.

It is ignored in production builds, so it can't be switched on by accident on Railway.

## Daily use

From the repo root:

```powershell
pnpm dev:local
```

This starts the local database (if it isn't running), then the API on http://localhost:4000/api/v1 and the web app on http://localhost:3000. Sign in at http://localhost:3000/login as `developer@example.test` with the `LOCAL_DEV_PASSWORD` from `apps/api/.env`.

| Command | What it does |
|---|---|
| `pnpm dev:local` | Start the database, API and web app in local mode |
| `pnpm test:local` | Smoke-test the running API (login, every report endpoint, tool create/update/delete) |
| `pnpm db:local:start` | Start PostgreSQL only |
| `pnpm db:local:stop` | Stop PostgreSQL |
| `pnpm db:local:status` | Show whether PostgreSQL is running |

Stop the dev servers with Ctrl+C. PostgreSQL keeps running in the background until you run `pnpm db:local:stop` or restart the machine.

## One-time setup

### Prerequisites

- Node.js 20+ and pnpm (`corepack enable` picks up the version pinned in `package.json`)
- `pnpm install` run from the repo root

### 1. Portable PostgreSQL

Everything lives under `scratch/local/`, which is git-ignored.

1. Download the PostgreSQL 16 **Windows x86-64 binaries zip** (not the installer) from https://www.enterprisedb.com/download-postgresql-binaries.
2. Extract it so that `scratch/local/pgsql/bin/pg_ctl.exe` exists.
3. Check that it runs:

   ```powershell
   .\scratch\local\pgsql\bin\pg_ctl.exe --version
   ```

   If this prints nothing and `$LASTEXITCODE` is `-1073741515` (`0xC0000135`, DLL not found), the Microsoft Visual C++ runtime is missing. Either install the [Visual C++ Redistributable (x64)](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist), or copy `vcruntime140.dll`, `vcruntime140_1.dll` and `msvcp140*.dll` into `scratch\local\pgsql\bin\` from any app that ships them (for example `C:\Program Files (x86)\Microsoft\Edge\Application\<version>\`).

4. Create the data directory, choosing a superuser password when prompted:

   ```powershell
   .\scratch\local\pgsql\bin\initdb.exe -D .\scratch\local\database -U postgres -A scram-sha-256 -E UTF8 -W
   ```

5. Start it and create the app's role and database (port 5433, matching `.env.example`):

   ```powershell
   pnpm db:local:start
   ```

   ```powershell
   .\scratch\local\pgsql\bin\psql.exe -h 127.0.0.1 -p 5433 -U postgres -c "CREATE ROLE spm_user LOGIN PASSWORD '<choose-a-password>';" -c "CREATE DATABASE spend_management OWNER spm_user;"
   ```

The scripts listen on `127.0.0.1` only, so the database isn't reachable from other machines.

### 2. Environment files

Copy the examples:

```powershell
Copy-Item apps\api\.env.example apps\api\.env
```

```powershell
Copy-Item apps\web\.env.example apps\web\.env.local
```

In `apps/api/.env` set:

```env
NODE_ENV=development
DATABASE_URL="postgresql://spm_user:<password-from-step-1>@localhost:5433/spend_management"
LOCAL_DEV_MODE=true
LOCAL_DEV_PASSWORD="<at-least-12-characters>"
DISABLE_INPROCESS_SCHEDULER=true
```

Leave the Google and Resend values empty. `REDIS_URL` can stay at its default; nothing needs Redis to be running.

In `apps/web/.env.local` set:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_LOCAL_DEV_MODE=true
```

### 3. Schema and local account

```powershell
cd apps\api
```

```powershell
npx prisma migrate deploy
```

```powershell
npx prisma generate
```

```powershell
$env:NODE_ENV='development'; $env:LOCAL_DEV_MODE='true'; pnpm db:seed:local
```

`db:seed:local` creates a **Local Development** organization with an Engineering department and the `developer@example.test` admin account. It refuses to run unless `DATABASE_URL` points at `spend_management` on localhost, so it can't touch a shared database. Re-run it any time to reset the account's password to the current `LOCAL_DEV_PASSWORD`.

If you've copied real data into the local database (for example from Railway), set `LOCAL_DEV_ORG_SLUG` to that organization's slug before seeding. The developer account then joins that existing org as an admin of its first department instead of creating the Local Development org:

```powershell
$env:NODE_ENV='development'; $env:LOCAL_DEV_MODE='true'; $env:LOCAL_DEV_ORG_SLUG='default-org'; pnpm db:seed:local
```

Then go back to the repo root and run `pnpm dev:local`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Local PostgreSQL is not initialized` | `scratch/local/pgsql` or `scratch/local/database` is missing — redo step 1. |
| `PostgreSQL failed to start` | Read `scratch/local/postgres.log`. If `pg_ctl` exits with `-1073741515`, see the Visual C++ runtime note in step 1. If port 5433 is in use, stop the other PostgreSQL (or Docker container) first. |
| `Local environment files are missing` | Create `apps/api/.env` and `apps/web/.env.local` (step 2). |
| Login page still shows Google SSO | `NEXT_PUBLIC_LOCAL_DEV_MODE=true` is missing from `apps/web/.env.local`, or you started the web app with `pnpm dev` instead of `pnpm dev:local`. Restart after changing it. |
| `Invalid credentials` | Re-run `pnpm db:seed:local` so the stored password matches `LOCAL_DEV_PASSWORD`. |
| `Local seed requires development mode…` | Set `NODE_ENV=development` and `LOCAL_DEV_MODE=true` in the shell (step 3), and check `DATABASE_URL` points at localhost. |
| Prisma errors about a missing client or unknown fields | Run `npx prisma generate` in `apps/api`, then restart. |
