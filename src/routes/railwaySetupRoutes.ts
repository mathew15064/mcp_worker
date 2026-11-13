import express from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import databaseManager from '../db/databaseManager';
import { timingSafeStringEqual } from '../services/adminIdentityService';

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

let claimInProgress = false;

async function isOwnerSetupComplete() {
  if (!databaseManager.isRailwaySqliteReady()) return false;
  const db = databaseManager.getAdapter();
  const row = await db?.queryOne<{ value: string }>(
    'SELECT value FROM system_settings WHERE key = ?',
    ['bootstrap.admin_password_hash'],
  );
  return Boolean(row?.value);
}
function html(content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure Setup — mcp_worker</title><meta name="robots" content="noindex,nofollow"><style>
body{background:#f5f7fa;color:#172037;font:16px system-ui;margin:0;padding:3rem 1rem}
main{max-width:630px;margin:auto;background:white;border:1px solid #dce3ec;border-radius:16px;padding:2rem} .hint{color:#4b5563;font-size:.92rem;line-height:1.5}.steps{padding-left:1.4rem;line-height:1.75}.steps li::marker{color:#2754a8;font-weight:700}.alert{background:#fff7e6;border:1px solid #f1cc84;padding:12px;border-radius:8px}
label{display:block;font-weight:600;margin-top:1rem}input{box-sizing:border-box;display:block;width:100%;padding:12px;margin-top:.4rem}
button{background:#172037;color:white;border:0;border-radius:8px;padding:12px 18px;margin-top:1.4rem}
</style></head><body><main><h1>mcp_worker</h1><h2>Set up your private instance</h2>
${content}<p class="hint">No default Admin password. The setup key is only entered here, never in a URL. Store your new Admin password privately; do not paste it into ChatGPT.</p></main></body></html>`;
}
router.get('/setup', async (req, res, next) => {
  try {
    if (process.env.MCP_PLATFORM !== 'railway') return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (await isOwnerSetupComplete()) return res.redirect('/login');
    if (!databaseManager.isRailwaySqliteReady())
      return res
        .status(503)
        .send(
          html(
            '<p class="alert">Blocked: the persistent Railway SQLite volume is unavailable. Check the attached volume in Railway, then reload. Setup cannot continue until storage is restored; existing data is not reset.</p>',
          ),
        );
    const csrf = String(req.session?.csrfToken || '').replace(/[^A-Za-z0-9_-]/g, '');
    return res.type('html').send(
      html(`<p><strong>Step 1 of 6: Create your Admin</strong></p>
<p>Enter the private setup key saved during Railway Deploy and choose a <strong>different</strong> Admin password (at least 14 characters). This form is a one-time claim, not an OAuth authorization.</p>
<form action="/setup" method="post"><input type="hidden" name="_csrf" value="${csrf}">
<label>Private setup key<input type="password" name="setup_key" minlength="43" autocomplete="off" aria-describedby="key-help" required></label>
<p class="hint" id="key-help">Retrieve the key from your own protected deployment setup instructions. Do not put it in a URL or chat.</p>
<label>Admin password<input type="password" name="password" minlength="14" maxlength="256" autocomplete="new-password" required></label>
<label>Confirm password<input type="password" name="confirm_password" minlength="14" maxlength="256" autocomplete="new-password" required></label>
<button type="submit">Create Admin and continue</button></form>
<h3>What happens next?</h3><ol class="steps"><li>Sign in with your Admin password.</li><li>Check the persistent database and copy the HTTPS MCP endpoint.</li><li>Create an OAuth client with your actual ChatGPT callback and minimum scopes.</li><li>Enroll and connect a Worker <strong>only if a signed release is approved</strong>.</li><li>Connect the MCP endpoint in ChatGPT and explicitly approve OAuth.</li><li>Make a read-only authenticated <code>runtime_info</code> call and check the audit evidence.</li></ol>
<p class="alert">Worker installers may return HTTP 503: signed Worker release approval is pending. The wizard will show this blocker rather than claiming the instance is ready. No shell access or OAuth consent is granted automatically.</p>`),
    );
  } catch (error) {
    next(error);
  }
});
router.post('/setup', limiter, async (req, res) => {
  if (process.env.MCP_PLATFORM !== 'railway') return res.sendStatus(404);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const fields: Record<string, unknown> =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const key = typeof fields.setup_key === 'string' ? fields.setup_key : '';
  const password = typeof fields.password === 'string' ? fields.password : '';
  const confirmed = typeof fields.confirm_password === 'string' ? fields.confirm_password : '';
  if (
    !timingSafeStringEqual(key, process.env.MCP_SETUP_SECRET || '') ||
    key.length < 43 ||
    password.length < 14 ||
    password.length > 256 ||
    password !== confirmed ||
    password === key
  )
    return res.status(403).type('html').send(html('<p>Invalid setup key or password.</p>'));
  if (!databaseManager.isRailwaySqliteReady())
    return res.status(503).type('html').send(html('<p>Database is unavailable.</p>'));
  if (claimInProgress)
    return res.status(409).type('html').send(html('<p>Owner setup is already running.</p>'));
  claimInProgress = true;
  try {
    if (await isOwnerSetupComplete())
      return res.status(409).type('html').send(html('<p>Owner exists. Sign in at /login.</p>'));
    const hash = await bcrypt.hash(password, 12);
    const db = databaseManager.requireAdapter();
    const result = await db.execute(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
      ['bootstrap.admin_password_hash', hash, new Date().toISOString()],
    );
    if (result.changes !== 1)
      return res.status(409).type('html').send(html('<p>Owner exists. Sign in at /login.</p>'));
    if (req.session) req.session.returnTo = '/admin/onboarding';
    return res.redirect(303, '/login');
  } catch {
    return res
      .status(503)
      .type('html')
      .send(html('<p>Setup failed. Verify the persistent volume and retry.</p>'));
  } finally {
    claimInProgress = false;
  }
});

export = Object.assign(router, { isOwnerSetupComplete });
