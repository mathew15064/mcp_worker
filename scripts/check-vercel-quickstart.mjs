#!/usr/bin/env node
/** Read-only verification for a NEW Vercel deployment. Never POST or provision. */
const target = process.argv[2];
if (process.argv.length !== 3 || target === '--help') {
  console.log('Usage: node scripts/check-vercel-quickstart.mjs https://NEW-PROJECT.vercel.app');
  process.exitCode = target === '--help' ? 0 : 2;
} else {
  let root;
  try { root = new URL(target); } catch { process.exitCode = 2; }
  if (!root ||
      root.protocol !== 'https:' ||
      !root.hostname.endsWith('.vercel.app') ||
      root.hostname === 'vercel.app' ||
      root.username || root.password || root.port ||
      root.pathname !== '/' || root.search || root.hash) {
    console.error('Refusing invalid, non-Vercel or credential-bearing URL.');
    process.exitCode = 2;
  } else {
    const results = [];
    async function probe(path, method = 'GET') {
      try {
        const res = await fetch(new URL(path, root), {
          method, redirect: 'manual',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        let data = null;
        if (res.headers.get('content-type')?.includes('application/json')) {
          const raw = await res.text();
          if (raw.length <= 16384) {
            try { data = JSON.parse(raw); } catch {}
          }
        }
        return { status: res.status, location: res.headers.get('location'), data };
      } catch { return { status: 0, location: null, data: null }; }
    }
    function gate(name, ok, detail) {
      results.push(ok);
      console.log((ok ? 'PASS ' : 'BLOCKED ') + name + ': ' + detail);
    }
    const ready = await probe('/readyz');
    const missing = Array.isArray(ready.data?.missing)
      ? ready.data.missing.filter(x => typeof x === 'string').slice(0, 6).join(', ')
      : '';
    gate('readiness', ready.status === 200 && ready.data?.ready === true,
      'HTTP ' + ready.status + (missing ? '; missing ' + missing : ''));
    const setup = await probe('/setup');
    let claimed = false;
    if ([301, 302, 303, 307, 308].includes(setup.status)) {
      try { claimed = new URL(setup.location || '/', root).pathname === '/login'; }
      catch {}
    }
    gate('Secure Setup locked', claimed, 'HTTP ' + setup.status);
    const oauth = await probe('/.well-known/oauth-authorization-server');
    const issuer = typeof oauth.data?.issuer === 'string' ? oauth.data.issuer : '';
    gate('OAuth discovery', oauth.status === 200 && issuer.startsWith('https://') &&
      oauth.data?.token_endpoint === issuer + '/oauth/token', 'HTTP ' + oauth.status);
    for (const [name, endpoint] of [
      ['Worker checksum manifest', '/worker/dist/SHA256SUMS'],
      ['Worker signed manifest', '/worker/dist/SHA256SUMS.sig'],
      ['Worker Linux binary', '/worker/dist/bot-report-worker-linux-amd64'],
    ]) {
      const check = await probe(endpoint, 'HEAD');
      gate(name, check.status === 200, 'HTTP ' + check.status);
    }
    const passed = results.every(Boolean);
    console.log(passed
      ? 'Read-only probes PASS. Live OAuth/PKCE, signature verification, WSS and isolation require separate E2E.'
      : 'Quickstart not certified; no resources or credentials were modified.');
    if (!passed) process.exitCode = 1;
  }
}
