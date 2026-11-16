# Historical OAuth scope escalation — owner-reviewed recovery plan

**Status:** DRY-RUN ONLY. No automatic migration, token revocation, or production database access is authorized.

The earlier version of `2026_11_02_000012_add_user_ownership_to_workers` could overwrite existing OAuth client scopes with `bot_report.read`, `bot_report.terminal` and `offline_access`. The corrected migration no longer adds grants, but a database that already executed the historical version can retain the broadened scopes. The migration ledger alone cannot distinguish a legitimate elevated grant from one introduced by the bug.

## Audit without touching production

1. Obtain an **independently approved, sanitized, offline snapshot** containing only `client_id`, `status` and `allowed_scopes_json`. The relevant read-only SQL on an authorized disposable clone is:
   ```sql
   SELECT client_id, status, allowed_scopes_json
   FROM mcp_oauth_clients ORDER BY client_id;
   ```
   Do not export client secrets, access/refresh tokens, private keys or personal data. Confirm whether migration `2026_11_02_000012_add_user_ownership_to_workers` is in the `migrations` ledger, but do **not** infer original grants from its presence.
2. The owner reviews **per-client independent grant records** (earlier backed-up scopes, a signed approval register or a validated audit trail). Prepare `OWNER_REVIEWED.json` mapping each client ID to its explicitly authorized scopes. Missing evidence must remain `OWNER_GRANT_EVIDENCE_REQUIRED`; it must never trigger an automatic downgrade or approval.
3. Run only the read-only JSON tool:
   ```sh
   node scripts/audit-historical-oauth-scopes.cjs \
     --snapshot /tmp/mcpw-authorized-fixture-sanitized.json \
     --approved /tmp/mcpw-owner-reviewed-grants.json
   ```
   The tool never opens a database, accepts no apply flag and emits `DRY_RUN_ONLY` proposals. It proposes removing only current scopes absent from a verified per-client approval; conflicts and unattributed elevated scopes require manual review.
4. Obtain owner sign-off for the *specific* clients, expected current grants, target grants, outage/notification window, safe backup/restore process and reauthorization impact. No bulk revoke based only on a migration version.

## Proposed data repair (not authorized to run on production)

On a **disposable** clone first, within one database transaction per client:

- Compare `allowed_scopes_json` to the exact snapshot value under a row lock or an optimistic `WHERE client_id = ? AND allowed_scopes_json = ?` precondition. Abort on conflict or changed grants.
- Change grants to the explicitly approved intersection; never add a scope that was not already present.
- Revoke **all outstanding access and refresh tokens belonging to that client** in the same transaction. Merely narrowing future grants does not invalidate previously issued tokens.
- Audit the change with owner approval and a count of revoked tokens (not token values), verify no cross-client changes, and require affected clients to re-authorize. Include runtime caches/introspection and long-lived external sessions in the rollout checklist.
- Preserve a tested encrypted pre-change backup and a restore plan. Scope metadata can be restored, but revoked tokens **must not be un-revoked**; a rollback requires new client authorization. Never claim a token-revocation operation is reversibly undoable.

A SQLite in-memory fixture test demonstrates the narrowed grant, same-client access/refresh revocation, preservation of unrelated clients and metadata-only rollback. That simulation is **not** a production repair migration or an externally tested restore.

## Release blockers and owner decisions

- Approve evidence for each historical grant and decide whether unverified elevated clients are disabled/re-authorized pending review.
- Approve active token/session revocation, affected user notification and a non-disruptive window.
- Approve snapshot backups, key custody, rollback, compliance retention and independent restore test.
- Run the migration/audit on an approved representative **offline clone** using SQLite before any live change.
- Until these decisions are made: keep historical data unchanged and release status **NO_GO**.
