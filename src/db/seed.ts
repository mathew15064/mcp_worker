import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from './connection';
import type Database from 'better-sqlite3';
import config from '../config/env';

export function seedInitialAdmin(db: Database.Database | null = null) {
  const database = db || getDb();
  if (database.prepare('SELECT id FROM users LIMIT 1').get()) return;
  const password = config.ADMIN_PASSWORD;
  if (!password || password.trim().length < 8) {
    throw new Error(
      '[BOOTSTRAP_ERROR] ADMIN_PASSWORD is required for the initial MCP authorization administrator (minimum 8 characters).',
    );
  }
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, session_version, created_at, updated_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
    )
    .run(crypto.randomUUID(), config.ADMIN_USERNAME, bcrypt.hashSync(password, 10), now, now);
  console.log(
    `[BOOTSTRAP] MCP authorization administrator '${config.ADMIN_USERNAME}' initialized.`,
  );
}
