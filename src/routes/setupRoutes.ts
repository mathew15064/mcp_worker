import express from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import databaseManager from '../db/databaseManager';
import runtimeSettings from '../services/runtimeSettingsService';
import { timingSafeStringEqual } from '../services/adminIdentityService';

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

// A warm Function may have observed a blank Neon database before a different
// Function completed Secure Setup. Recheck at most once per 10s per Function
// instead of leaving all subsequent login requests in a /setup redirect loop.
let lastReconnectAt = 0;
let reconnecting: Promise<void> | null = null;
let ownerClaimInProgress = false;
async function refreshManagedDatabase() {
  if (process.env.MCP_PLATFORM !== 'vercel' || databaseManager.isManagedPostgresReady()) return;
  if (ownerClaimInProgress) return;
  const state = databaseManager.status().state;
  if (state !== 'CONFIGURED' && state !== 'DEGRADED') return;
  if (reconnecting) return reconnecting;
  const now = Date.now();
  if (now - lastReconnectAt < 10000) return;
  lastReconnectAt = now;
  const pending = databaseManager.connectManagedPostgres().then(() => {});
  reconnecting = pending;
  try {
    await pending;
  } finally {
    if (reconnecting === pending) reconnecting = null;
  }
}

async function isOwnerSetupComplete() {
  await refreshManagedDatabase();
  if (!databaseManager.isManagedPostgresReady()) return false;
  const db = databaseManager.getAdapter();
  const result = await db?.queryOne<{ value: string }>(
    'SELECT value FROM system_settings WHERE key = ?',
    ['bootstrap.admin_password_hash'],
  );
  return Boolean(result?.value);
}

function safe(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] || '',
  );
}

function page(content: string, csrf: string) {
  void csrf;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure Setup — mcp_worker</title><style>body{font:16px system-ui;background:#f5f7fa;color:#172037;margin:0;padding:3rem 1rem}.panel{max-width:530px;margin:auto;background:white;border:1px solid #dce3ec;border-radius:16px;padding:2rem;box-shadow:0 9px 30px #15243c12}label{display:block;font-weight:600;margin-top:1rem}input{box-sizing:border-box;display:block;width:100%;margin-top:.4rem;border:1px solid #b8c5d4;border-radius:8px;padding:12px;font:inherit}button{background:#172037;color:white;border:0;border-radius:8px;padding:12px 18px;margin-top:1.4rem;cursor:pointer}p,li{color:#48556b;line-height:1.5}small{color:#5c6676}code{background:#ecf0f5;padding:2px 5px;border-radius:4px}</style></head><body><main class="panel"><h1>mcp_worker</h1><h2>Set up your private instance</h2>${content}<footer><hr><small>Secrets stay in your Vercel Project and are never sent to the original project's server.</small></footer></main></body></html>`;
}

router.get('/setup', async (req, res, next) => {
  try {
    if (process.env.MCP_PLATFORM !== 'vercel') return res.redirect('/admin');
    res.set('Cache-Control', 'no-store');
    if (await isOwnerSetupComplete()) return res.redirect('/login');
    const state = databaseManager.status();
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL)
      return res
        .status(503)
        .type('html')
        .send(
          page(
            '<p>Step 1: connect <strong>Neon PostgreSQL</strong> from Vercel Marketplace, then redeploy. No database password needs to be pasted into this website.</p>',
            '',
          ),
        );
    if (state.state === 'DEGRADED')
      return res
        .status(503)
        .type('html')
        .send(
          page(
            '<p>Neon connection unavailable. Check the Vercel Storage integration and redeploy.</p>',
            '',
          ),
        );
    const disabled = process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production';
    const csrf = String(req.session?.csrfToken || '');
    if (disabled)
      return res
        .status(403)
        .type('html')
        .send(
          page(
            '<p>Owner setup is restricted to the production deployment. Preview deployments cannot initialize the production database.</p>',
            csrf,
          ),
        );
    return res
      .type('html')
      .send(
        page(
          `<p>Neon is connected. Finish setup once, using the private setup key you entered during Deploy (and saved in your password manager).</p><form action="/setup" method="post"><input type="hidden" name="_csrf" value="${safe(csrf)}"><label>Private setup key<input name="setup_key" type="password" autocomplete="off" minlength="43" required></label><label>Admin password (14+ characters)<input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" minlength="14" maxlength="256" required></label><button type="submit">Create private instance</button></form>`,
          csrf,
        ),
      );
  } catch (error) {
    next(error);
  }
});

router.post('/setup', limiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (process.env.MCP_PLATFORM !== 'vercel') return res.sendStatus(404);
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return res.sendStatus(403);
  const body: unknown = req.body;
  const fields: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const key = typeof fields.setup_key === 'string' ? fields.setup_key : '';
  const password = typeof fields.password === 'string' ? fields.password : '';
  const confirm = typeof fields.confirm_password === 'string' ? fields.confirm_password : '';
  if (
    !timingSafeStringEqual(key, process.env.MCP_SETUP_SECRET || '') ||
    key.length < 43 ||
    password.length < 14 ||
    password.length > 256 ||
    password !== confirm ||
    password === key
  ) {
    return res
      .status(403)
      .type('html')
      .send(
        page(
          '<p>Invalid setup key or password. Check the secret stored in your Vercel Project and use a strong, distinct Admin password.</p>',
          '',
        ),
      );
  }
  let acquiredClaimLock = false;
  try {
    if (await isOwnerSetupComplete()) return res.status(409).redirect('/login');
    if (ownerClaimInProgress) return res.status(409).redirect('/setup');
    ownerClaimInProgress = true;
    acquiredClaimLock = true;
    if (!databaseManager.isManagedPostgresReady()) {
      const prepared = await databaseManager.prepareManagedPostgresInitialization();
      await databaseManager.activatePrepared(prepared);
    }
    const db = databaseManager.requireAdapter();
    await runtimeSettings.seedDefaults(db);
    const hash = await bcrypt.hash(password, 12);
    const created = await db.execute(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING',
      ['bootstrap.admin_password_hash', hash, new Date().toISOString()],
    );
    if (created.changes !== 1) return res.status(409).redirect('/login');
    return res.redirect(303, '/login');
  } catch (error) {
    console.error(
      '[VERCEL_SETUP] setup failed:',
      error instanceof Error && 'code' in error ? String(error.code) : 'ERROR',
    );
    return res
      .status(503)
      .type('html')
      .send(
        page(
          '<p>Secure setup was not completed. Check the database connection in Vercel and retry. Your setup key has not been stored.</p>',
          '',
        ),
      );
  } finally {
    if (acquiredClaimLock) ownerClaimInProgress = false;
  }
});

export = Object.assign(router, { isOwnerSetupComplete });
