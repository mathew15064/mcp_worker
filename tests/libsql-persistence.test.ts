import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner } from '../src/db/migrationRunner';
import settingsRepository from '../src/repositories/settingsRepository';
import userRepository from '../src/repositories/userRepository';

void test('libSQL settings and user records survive closing and reopening the connection', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_worker_libsql_persistence_'));
  const url = `file:${path.join(directory, 'storage.sqlite')}`;
  const first = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  try {
    await new MigrationRunner(first).migrate();
    const settings = new settingsRepository.SettingsRepository(first);
    const users = new userRepository.UserRepository(first);
    await settings.set('mcp.enabled', 'true');
    await settings.set('mcp.enabled', 'false');
    assert.equal(await settings.get('mcp.enabled'), 'false');
    await users.create({
      id: 'test-user',
      username: 'libsql-user',
      email: null,
      display_name: 'Test User',
      password_hash: 'fixture-hash',
      principal_id: 'principal:user:fixture',
      profile_id: 'profile-fixture',
      created_at: '2026-11-11T00:00:00Z',
      updated_at: '2026-11-11T00:00:00Z',
    });
    assert.equal((await users.findById('test-user'))?.username, 'libsql-user');
  } finally {
    await first.close();
  }

  const second = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  try {
    const settings = new settingsRepository.SettingsRepository(second);
    const users = new userRepository.UserRepository(second);
    assert.equal(await settings.get('mcp.enabled'), 'false');
    const user = await users.findById('test-user');
    assert.equal(user?.id, 'test-user');
    assert.equal(user?.session_version, 1);
    await users.setStatus('test-user', 'disabled');
    assert.equal((await users.findById('test-user'))?.session_version, 2);
    assert.equal((await new MigrationRunner(second).migrate()).ran.length, 0);
  } finally {
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
