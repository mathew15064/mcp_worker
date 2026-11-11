// Transitional build: keep unmigrated JS unchanged; compile strict TS into
// the same relative layout. All generated files live outside the source tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const name of ['src', 'scripts', 'worker', 'tests', 'package.json', 'playwright.config.js']) {
  const source = path.join(root, name);
  if (!fs.existsSync(source)) continue;
  fs.cpSync(source, path.join(dist, name), {
    recursive: true,
    filter: file => !file.split(path.sep).includes('node_modules') && !file.endsWith('.ts')
  });
}
try {
  execFileSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
} catch (error) {
  fs.rmSync(dist, { recursive: true, force: true });
  throw error;
}
console.log('Build complete: dist/');
