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
// Browser assets are typechecked by the strict project compiler, then emitted
// as plain scripts (no CommonJS exports/require) for direct <script defer> use.
const ts = require('typescript');
const publicDir = path.join(root, 'src', 'public');
if (fs.existsSync(publicDir)) {
  for (const name of fs.readdirSync(publicDir)) {
    if (!name.endsWith('.ts')) continue;
    const source = path.join(publicDir, name);
    const target = path.join(dist, 'src', 'public', name.replace(/\.ts$/, '.js'));
    const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      fileName: name,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, strict: true }
    });
    fs.writeFileSync(target, compiled.outputText);
    if (/\b(?:require|exports|module\.exports)\b/.test(compiled.outputText)) {
      throw new Error('Browser script contains CommonJS dependency: ' + name);
    }
  }
}
console.log('Build complete: dist/');
