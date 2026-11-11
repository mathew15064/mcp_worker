#!/usr/bin/env node
const crypto = require('crypto');

const generated = process.argv.includes('--generate');
if (generated) {
  const password = `${crypto.randomBytes(18).toString('base64url')}!Aa9`;
  console.log(`Generated ADMIN_PASSWORD: ${password}`);
  console.log('Set this value in the runtime environment and restart mcp_worker.');
  process.exit(0);
}

console.error('Administrator credentials are now bootstrap-only ENV configuration.');
console.error('Update ADMIN_USERNAME / ADMIN_PASSWORD in the runtime environment and restart mcp_worker.');
console.error('Use --generate only to generate a strong candidate password; this command no longer writes any database.');
process.exit(1);
