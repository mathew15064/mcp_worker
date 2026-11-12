const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname,'..');
execFileSync(process.execPath,[path.join(root,'scripts/build.cjs')],{cwd:root,stdio:'inherit'});
const origin = path.join(root,'dist/src/public');
const target = path.join(root,'public/assets');
fs.mkdirSync(target,{recursive:true});
for(const item of fs.readdirSync(origin)) {
  if (!/\.(css|js|svg|png|webp|ico)$/.test(item)) continue;
  fs.copyFileSync(path.join(origin,item),path.join(target,item));
}
console.log('Vercel assets staged in public/assets.');
