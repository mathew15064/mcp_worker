#!/usr/bin/env node
'use strict';

// Read-only audit: accepts sanitized JSON exports, never opens a database.
const fs = require('node:fs');

function scopeList(value, field) {
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !s || s.length > 120)) {
    throw new Error(field + ' must be an array of scope strings');
  }
  if (new Set(value).size !== value.length) throw new Error(field + ' contains duplicate scopes');
  return value;
}

function plan(snapshot, approved) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.clients) ||
    !approved ||
    !approved.approved_scopes_by_client ||
    typeof approved.approved_scopes_by_client !== 'object' ||
    Array.isArray(approved.approved_scopes_by_client)
  ) {
    throw new Error('Expected sanitized clients[] and independently approved scopes map');
  }
  const seen = new Set();
  const items = snapshot.clients.map((row) => {
    if (
      !row ||
      typeof row.client_id !== 'string' ||
      !row.client_id ||
      Object.keys(row).some((key) => !['client_id', 'allowed_scopes_json', 'status'].includes(key))
    ) {
      throw new Error('Snapshot rows must contain only client_id, allowed_scopes_json and status');
    }
    if (seen.has(row.client_id)) throw new Error('Duplicate OAuth client in snapshot');
    seen.add(row.client_id);
    let current;
    try {
      current = scopeList(JSON.parse(row.allowed_scopes_json), 'allowed_scopes_json');
    } catch {
      throw new Error('Invalid allowed_scopes_json for client ' + row.client_id);
    }
    const hasApproval = Object.hasOwn(approved.approved_scopes_by_client, row.client_id);
    const baseline = hasApproval
      ? scopeList(approved.approved_scopes_by_client[row.client_id], 'approved grant')
      : null;
    if (!baseline) {
      return {
        client_id: row.client_id,
        current_scopes: current,
        disposition: current.some((s) => s !== 'mcp_worker.read')
          ? 'OWNER_GRANT_EVIDENCE_REQUIRED'
          : 'READ_ONLY_NO_CHANGE',
        proposed_scopes: null,
        revoke_issued_tokens: false,
      };
    }
    if (baseline.some((s) => !current.includes(s))) {
      return {
        client_id: row.client_id,
        current_scopes: current,
        disposition: 'BASELINE_CONFLICT_MANUAL_REVIEW',
        proposed_scopes: null,
        revoke_issued_tokens: false,
      };
    }
    const proposed = current.filter((s) => baseline.includes(s));
    const needsChange = proposed.length !== current.length;
    return {
      client_id: row.client_id,
      current_scopes: current,
      disposition: needsChange ? 'PROPOSE_REMOVE_UNAPPROVED_SCOPES' : 'MATCHES_APPROVED_GRANT',
      proposed_scopes: needsChange ? proposed : null,
      revoke_issued_tokens: needsChange,
    };
  });
  const missing = Object.keys(approved.approved_scopes_by_client).filter((id) => !seen.has(id));
  if (missing.length) throw new Error('Approved grants contain clients absent from snapshot');
  return {
    status: 'DRY_RUN_ONLY',
    source: 'sanitized_json_snapshot_not_live_database',
    rule: 'No grant can be inferred from the historical migration; owner approval and backup are mandatory',
    clients: items,
    proposed_changes: items.filter((x) => x.disposition === 'PROPOSE_REMOVE_UNAPPROVED_SCOPES')
      .length,
    manual_review: items.filter((x) =>
      ['OWNER_GRANT_EVIDENCE_REQUIRED', 'BASELINE_CONFLICT_MANUAL_REVIEW'].includes(x.disposition),
    ).length,
    authorization_to_apply: false,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--snapshot' || args[2] !== '--approved') {
    process.stderr.write(
      'Usage: node scripts/audit-historical-oauth-scopes.cjs --snapshot SANITIZED.json --approved OWNER_REVIEWED.json\n',
    );
    process.exitCode = 2;
  } else {
    try {
      const snapshot = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      const approved = JSON.parse(fs.readFileSync(args[3], 'utf8'));
      process.stdout.write(JSON.stringify(plan(snapshot, approved), null, 2) + '\n');
    } catch (error) {
      process.stderr.write(
        'Audit refused: ' + (error instanceof Error ? error.message : 'invalid input') + '\n',
      );
      process.exitCode = 2;
    }
  }
}

module.exports = { plan };
