import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const script = path.resolve(__dirname, '../../scripts/audit-historical-oauth-scopes.cjs');

void test('historical OAuth grant audit dry-runs only, requires per-client evidence, and models token revocation on disposable SQLite', () => {
  const db = new Database(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpw-p1-oauth-fixture-'));
  try {
    db.exec(`
      CREATE TABLE mcp_oauth_clients (client_id TEXT PRIMARY KEY, status TEXT, allowed_scopes_json TEXT NOT NULL);
      CREATE TABLE mcp_oauth_access_tokens (client_id TEXT, revoked_at TEXT);
      CREATE TABLE mcp_oauth_refresh_tokens (client_id TEXT, revoked_at TEXT);
    `);
    const insert = db.prepare('INSERT INTO mcp_oauth_clients VALUES (?, ?, ?)');
    const read = 'mcp_worker.read';
    const terminal = 'mcp_worker.terminal';
    const offline = 'offline_access';
    insert.run('legacy-widened', 'active', JSON.stringify([read, terminal, offline]));
    insert.run('approved-terminal', 'active', JSON.stringify([read, terminal]));
    insert.run('no-grant-record', 'active', JSON.stringify([read, terminal, offline]));
    insert.run('read-only', 'active', JSON.stringify([read]));
    for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
      db.prepare(`INSERT INTO ${table} VALUES (?, NULL)`).run('legacy-widened');
      db.prepare(`INSERT INTO ${table} VALUES (?, NULL)`).run('approved-terminal');
    }
    const before = db.prepare('SELECT * FROM mcp_oauth_clients ORDER BY client_id').all();
    const snapshot = { clients: before };
    const grants = {
      approved_scopes_by_client: {
        'legacy-widened': [read],
        'approved-terminal': [read, terminal],
      },
    };
    const snapFile = path.join(dir, 'sanitized-snapshot.json');
    const grantsFile = path.join(dir, 'owner-reviewed-grants-fixture.json');
    fs.writeFileSync(snapFile, JSON.stringify(snapshot));
    fs.writeFileSync(grantsFile, JSON.stringify(grants));
    const proc = spawnSync(
      process.execPath,
      [script, '--snapshot', snapFile, '--approved', grantsFile],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(proc.status, 0, proc.stderr);
    const output = JSON.parse(proc.stdout) as {
      status: string;
      proposed_changes: number;
      manual_review: number;
      authorization_to_apply: boolean;
      clients: Array<{
        client_id: string;
        disposition: string;
        current_scopes: string[];
        proposed_scopes: string[] | null;
        revoke_issued_tokens: boolean;
      }>;
    };
    assert.equal(output.status, 'DRY_RUN_ONLY');
    assert.equal(output.authorization_to_apply, false);
    assert.equal(output.proposed_changes, 1);
    assert.equal(output.manual_review, 1);
    const records = new Map(output.clients.map((c) => [c.client_id, c]));
    assert.equal(records.get('legacy-widened')?.disposition, 'PROPOSE_REMOVE_UNAPPROVED_SCOPES');
    assert.deepEqual(records.get('legacy-widened')?.proposed_scopes, [read]);
    assert.equal(records.get('legacy-widened')?.revoke_issued_tokens, true);
    assert.equal(records.get('approved-terminal')?.disposition, 'MATCHES_APPROVED_GRANT');
    assert.equal(records.get('no-grant-record')?.disposition, 'OWNER_GRANT_EVIDENCE_REQUIRED');
    assert.equal(records.get('no-grant-record')?.proposed_scopes, null);
    assert.deepEqual(
      db.prepare('SELECT * FROM mcp_oauth_clients ORDER BY client_id').all(),
      before,
      'audit must never mutate even a disposable database',
    );
    assert.equal(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_access_tokens WHERE revoked_at IS NULL')
          .get() as { n: number }
      ).n,
      2,
    );

    // Test the documented remediation only inside this in-memory fixture.
    // Production application would require a separate owner-approved workflow.
    const plan = records.get('legacy-widened');
    assert.ok(plan?.proposed_scopes);
    const fixtureApply = db.transaction(() => {
      const updated = db
        .prepare(
          'UPDATE mcp_oauth_clients SET allowed_scopes_json = ? WHERE client_id = ? AND allowed_scopes_json = ?',
        )
        .run(
          JSON.stringify(plan.proposed_scopes),
          plan.client_id,
          JSON.stringify(plan.current_scopes),
        );
      assert.equal(updated.changes, 1, 'optimistic current-scope precondition is required');
      for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
        db.prepare(
          `UPDATE ${table} SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`,
        ).run('disposable-fixture-revocation', plan.client_id);
      }
    });
    fixtureApply();
    const scopes = (id: string) =>
      JSON.parse(
        (
          db
            .prepare('SELECT allowed_scopes_json FROM mcp_oauth_clients WHERE client_id = ?')
            .get(id) as { allowed_scopes_json: string }
        ).allowed_scopes_json,
      ) as string[];
    assert.deepEqual(scopes('legacy-widened'), [read]);
    assert.deepEqual(scopes('approved-terminal'), [read, terminal], 'explicit grants must survive');
    assert.deepEqual(
      scopes('no-grant-record'),
      [read, terminal, offline],
      'no inferred automatic revocation',
    );
    for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
      const state = db
        .prepare(`SELECT revoked_at FROM ${table} WHERE client_id = ?`)
        .get('legacy-widened') as { revoked_at: string | null };
      assert.ok(state.revoked_at, 'issued tokens require invalidation after grant reduction');
      assert.equal(
        (
          db
            .prepare(`SELECT revoked_at FROM ${table} WHERE client_id = ?`)
            .get('approved-terminal') as {
            revoked_at: string | null;
          }
        ).revoked_at,
        null,
        'unaffected authorized clients must not lose tokens',
      );
    }
    // Grant metadata can be restored from a verified backup, but revoked tokens
    // must remain revoked; affected clients will need new authorization.
    db.prepare('UPDATE mcp_oauth_clients SET allowed_scopes_json = ? WHERE client_id = ?').run(
      JSON.stringify([read, terminal, offline]),
      'legacy-widened',
    );
    assert.deepEqual(scopes('legacy-widened'), [read, terminal, offline]);
    assert.notEqual(
      (
        db
          .prepare('SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE client_id = ?')
          .get('legacy-widened') as { revoked_at: string | null }
      ).revoked_at,
      null,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('historical OAuth audit rejects malformed or duplicated input without any database access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpw-p1-oauth-reject-'));
  try {
    const snap = path.join(dir, 'sanitized.json');
    const approved = path.join(dir, 'grants.json');
    fs.writeFileSync(approved, JSON.stringify({ approved_scopes_by_client: {} }));
    const run = () =>
      spawnSync(process.execPath, [script, '--snapshot', snap, '--approved', approved], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    fs.writeFileSync(
      snap,
      JSON.stringify({
        clients: [
          { client_id: 'dup', allowed_scopes_json: '["mcp_worker.read"]' },
          { client_id: 'dup', allowed_scopes_json: '["mcp_worker.read"]' },
        ],
      }),
    );
    assert.equal(run().status, 2);
    fs.writeFileSync(
      snap,
      JSON.stringify({
        clients: [{ client_id: 'invalid', allowed_scopes_json: 'broken' }],
      }),
    );
    assert.equal(run().status, 2);
    fs.writeFileSync(
      snap,
      JSON.stringify({
        clients: [
          {
            client_id: 'secret-row',
            allowed_scopes_json: '[]',
            client_secret_hash: 'must-not-be-processed',
          },
        ],
      }),
    );
    assert.equal(run().status, 2, 'unsanitized exports are rejected');
    fs.writeFileSync(
      snap,
      JSON.stringify({
        clients: [{ client_id: 'grant-conflict', allowed_scopes_json: '["mcp_worker.read"]' }],
      }),
    );
    fs.writeFileSync(
      approved,
      JSON.stringify({
        approved_scopes_by_client: { 'grant-conflict': ['mcp_worker.read', 'mcp_worker.terminal'] },
      }),
    );
    const output = run();
    assert.equal(output.status, 0);
    const parsed = JSON.parse(output.stdout) as {
      clients: Array<{ disposition: string; proposed_scopes: null }>;
    };
    assert.equal(parsed.clients[0].disposition, 'BASELINE_CONFLICT_MANUAL_REVIEW');
    assert.equal(parsed.clients[0].proposed_scopes, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
