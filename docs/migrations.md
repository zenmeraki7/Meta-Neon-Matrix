# Migration Safety (Neon + Prisma)

Use this project workflow for all production migrations, especially any change touching:
- `variant_metafields`
- `bulk_edit_sessions`
- `bulk_edit_changes`
- `sync_cursors`

## Required flow

1. Create backup branch in Neon:

```bash
neon branch create --name pre-migration-backup-<timestamp>
```

2. Deploy migrations:

```bash
cd web
npm run migrate:deploy
```

or use the guarded wrapper:

```bash
cd web
npm run migrate:deploy:safe
```

3. Smoke test key paths:
- `/api/variants`
- `/api/sessions/*`
- worker startup

4. If rollback is needed:

```bash
neon branch set-as-primary pre-migration-backup-<timestamp>
```

## Important rules

- Use `prisma migrate dev` and `prisma migrate deploy`.
- Do **not** use `prisma db push` in this project.
- Partial indexes must be hand-authored in migration SQL (`CREATE INDEX ... WHERE ...`).
- Keep Prisma `@@index` only as schema stubs for awareness; real partial behavior lives in SQL migrations.

