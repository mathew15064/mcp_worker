import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import workerRoutes = require('../src/routes/workerRoutes');

void test('GitHub-first RC installers remain offline-only and fail closed without approval', () => {
  const unix = [
    workerRoutes.githubLinuxInstallerScript(),
    workerRoutes.githubMacInstallerScript(),
  ];
  for (const installer of unix) {
    assert.match(installer, /https:\/\/github\.com/);
    assert.match(installer, /mathew15064\/mcp_worker\/releases\/download/);
    assert.match(installer, /--proto-redir '=https'/);
    assert.match(installer, /signed release not approved/);
    assert.match(installer, /\[ -z "\$GITHUB_RELEASE_PATH" \]/);
    if (process.platform !== 'win32') {
      const result = spawnSync('sh', ['-c', installer], { encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0, 'unsigned release must never run');
      assert.match(result.stderr, /signed release not approved/);
    }
  }
  const windows = workerRoutes.githubWindowsInstallerScript();
  assert.match(windows, /https:\/\/github\.com/);
  assert.match(windows, /Signed release not approved/);
  assert.match(windows, /\$GithubReleasePath/);
  assert.match(windows, /-MaximumRedirection \$MaxRedirects/);
});
