# Neon Prisma Reconcile Plan

Date: 2026-05-25  
Scope: Reconcile this Neon production environment to this repository's Prisma migration history so future `prisma migrate deploy` runs cleanly.

## Problem Summary

Current state (verified on 2026-05-24/25):

1. Neon DB has a different `_prisma_migrations` lineage than local `web/prisma/migrations`.
2. `prisma migrate deploy` fails with migration history mismatch before applying new migrations.
3. Manual compatibility SQL patches were applied to keep runtime stable, but migration history is still not reconciled.

## Target End State

1. Database schema matches `web/prisma/schema.prisma`.
2. `_prisma_migrations` contains only migration IDs present in this repo.
3. `npx prisma@6.19.2 migrate status --schema web/prisma/schema.prisma` reports no divergence.
4. Future CI can run `npx prisma@6.19.2 migrate deploy` safely.

## Safety Preconditions

1. Freeze deploys that include schema changes.
2. Take a Neon branch backup/snapshot first.
3. Run all commands with Prisma `6.19.2` (repo-compatible).

## Phase 1: Capture and Verify Current State

```powershell
$env:DATABASE_URL="<neon_connection_string>"
npx prisma@6.19.2 migrate status --schema web\prisma\schema.prisma
```

Backup migration metadata:

```sql
CREATE TABLE IF NOT EXISTS "_prisma_migrations_backup_20260525" AS
SELECT * FROM "_prisma_migrations";
```

## Phase 2: Generate a Baseline Migration From Live Neon Schema

This creates a local baseline SQL representing the DB as it exists now.

```powershell
$baselineId="20260525000100_neon_rebaseline"
New-Item -ItemType Directory -Path "web\prisma\migrations\$baselineId" -Force | Out-Null
$env:DATABASE_URL="<neon_connection_string>"
npx prisma@6.19.2 migrate diff `
  --from-empty `
  --to-url "$env:DATABASE_URL" `
  --script > "web\prisma\migrations\$baselineId\migration.sql"
```

Then commit this baseline folder.

## Phase 3: Reconcile `_prisma_migrations` to Repo History

Important: this step changes only migration bookkeeping, not table data.

1. Clear existing migration history rows.
2. Mark local migrations as applied in chronological order.

SQL:

```sql
TRUNCATE TABLE "_prisma_migrations";
```

PowerShell (from repo root):

```powershell
$env:DATABASE_URL="<neon_connection_string>"
Get-ChildItem "web\prisma\migrations" -Directory |
  Sort-Object Name |
  ForEach-Object {
    npx prisma@6.19.2 migrate resolve --applied $_.Name --schema web\prisma\schema.prisma
  }
```

Note:
1. Keep every migration folder that should be considered applied (including the new baseline folder).
2. Do not delete migration folders that are part of intended history.

## Phase 4: Validation

Run:

```powershell
$env:DATABASE_URL="<neon_connection_string>"
npx prisma@6.19.2 migrate status --schema web\prisma\schema.prisma
npx prisma@6.19.2 migrate deploy --schema web\prisma\schema.prisma
```

Expected:
1. `migrate status` shows no local/remote divergence.
2. `migrate deploy` completes successfully (no-op or applies pending migrations).

## Phase 5: CI/CD Guardrail

Add a pre-deploy check step:

```powershell
npx prisma@6.19.2 migrate status --schema web\prisma\schema.prisma
```

Fail deployment if status reports divergence.

## Rollback Plan

If reconciliation is incorrect:

1. Restore `_prisma_migrations` rows:

```sql
TRUNCATE TABLE "_prisma_migrations";
INSERT INTO "_prisma_migrations"
SELECT * FROM "_prisma_migrations_backup_20260525";
```

2. Re-point app to Neon backup branch if needed.

## Operational Notes

1. This plan is environment-specific for the current Neon DB lineage.
2. Do not run `migrate dev` against production.
3. Use `migrate deploy` only after history reconciliation is complete.
