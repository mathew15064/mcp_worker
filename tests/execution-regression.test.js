const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { TerminalMcpService, normalizeCapturedText } = require('../src/services/terminalMcpService');
const { TerminalSshService } = require('../src/services/terminalSshService');

function profile() {
  return { id: 'p1', name: 'Dev3', host: '127.0.0.1', port: 22, username: 'dev3', credential_envelope: 'enc', tmux_session: 'dev3', enabled: true };
}
function audit() { return { log() {} }; }
function service(ssh) {
  const p = profile();
  return new TerminalMcpService({
    profiles: { findAll: () => [p], findWithCredentialById: () => p },
    audit: audit(), credentials: { decrypt: () => 'fixture' }, ssh
  });
}

class MockChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stderr.resume = () => {};
    this.input = Buffer.alloc(0);
  }
  resume() {}
  close() { this.emit('close', 0); }
  end(input) {
    this.input = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
    setImmediate(() => this.emit('exit', 0));
  }
}

test('repo_snapshot parses compact git state', async () => {
  const ssh = { execWorkspaceCommand: async (_p, _pw, command, options) => {
    assert.equal(options.cwd, '/tmp/repo');
    assert.match(command, /status --porcelain/);
    return {
      exit_code: 0,
      stdout: ['ROOT\t/tmp/repo','BRANCH\tfeature/demo','HEAD\tabc123','UPSTREAM\torigin/feature/demo','COUNTS\t2\t1','BASE\tbase123','MERGE_BASE\tmerge123','__BR_STATUS__',' M src/a.js','?? tests/new.test.js',''].join('\n'),
      stderr: '', stdout_truncated: false, stderr_truncated: false
    };
  }};
  const result = await service(ssh).repoSnapshot('Dev3', '/tmp/repo', { runAs: 'dev5', base: 'origin/main' });
  assert.equal(result.branch, 'feature/demo');
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.changed_files.map(item => item.path), ['src/a.js', 'tests/new.test.js']);
  assert.equal(result.merge_base, 'merge123');
});

test('git_diff combines status, numstat, and bounded diff', async () => {
  let call = 0;
  const ssh = { execWorkspaceCommand: async () => {
    call += 1;
    if (call === 1) return {
      exit_code: 0,
      stdout: '__BR_NAME_STATUS__\nM\tsrc/a.js\nA\ttests/a.test.js\n__BR_NUMSTAT__\n3\t1\tsrc/a.js\n5\t0\ttests/a.test.js\n',
      stderr: '', stdout_truncated: false, stderr_truncated: false
    };
    return { exit_code: 0, stdout: 'diff --git a/src/a.js b/src/a.js\n+hello\n', stderr: '', stdout_truncated: true, stderr_truncated: false };
  }};
  const result = await service(ssh).gitDiff('Dev3', '/tmp/repo', { base: 'origin/main' });
  assert.equal(result.file_count, 2);
  assert.deepEqual(result.files[0], { path: 'src/a.js', status: 'M', additions: 3, deletions: 1 });
  assert.match(result.diff, /diff --git/);
  assert.equal(result.diff_truncated, true);
});

test('code_search parses ripgrep JSON and check_run parses TAP summary', async () => {
  const match = JSON.stringify({ type: 'match', data: { path: { text: './src/a.js' }, lines: { text: 'const needle = true;\n' }, line_number: 7, submatches: [{ start: 6, end: 12 }] } });
  let call = 0;
  const ssh = { execWorkspaceCommand: async () => {
    call += 1;
    if (call === 1) return { exit_code: 0, stdout: match + '\n', stderr: '', stdout_truncated: false, stderr_truncated: false };
    return {
      exit_code: 1,
      stdout: ['TAP version 13','ok 1 - alpha','not ok 2 - beta','# tests 2','# pass 1','# fail 1','# skipped 0'].join('\n'),
      stderr: 'Error: beta failed\n', duration_ms: 321, stdout_truncated: false, stderr_truncated: false
    };
  }};
  const target = service(ssh);
  const search = await target.codeSearch('Dev3', '/tmp/repo', 'needle', { maxResults: 10 });
  assert.deepEqual(search.matches[0], { file: './src/a.js', line: 7, column: 7, text: 'const needle = true;' });
  const check = await target.checkRun('Dev3', 'node --test', { cwd: '/tmp/repo', tailLines: 4 });
  assert.equal(check.status, 'FAIL');
  assert.deepEqual(check.summary, { tests: 2, passed: 1, failed: 1, skipped: 0, errors: null, assertions: null });
  assert.ok(check.failures.some(line => line.includes('not ok 2')));
});

test('process lifecycle and cursor logs delegate through one profile', async () => {
  const ssh = {
    startManagedProcess: async () => ({ process_id: 'brproc-0123456789abcdef', state: 'RUNNING', pid: 123, output: '' }),
    getManagedProcessStatus: async () => ({ process_id: 'brproc-0123456789abcdef', state: 'RUNNING', pid: 123, output: 'ready' }),
    readManagedProcessLogs: async () => ({ process_id: 'brproc-0123456789abcdef', cursor: 0, next_cursor: 5, log_size: 5, bytes: 5, eof: true, text: 'ready' }),
    stopManagedProcess: async () => ({ process_id: 'brproc-0123456789abcdef', state: 'STOPPED', exit_code: 0, pid: 123, cleaned_up: true, forced: false })
  };
  const target = service(ssh);
  const started = await target.processStart('Dev3', 'node server.js', { cwd: '/tmp' });
  assert.equal(started.state, 'RUNNING');
  assert.equal((await target.processStatus('Dev3', started.process_id)).output, 'ready');
  assert.equal((await target.processLogs('Dev3', started.process_id)).next_cursor, 5);
  assert.equal((await target.processStop('Dev3', started.process_id)).cleaned_up, true);
});

test('terminal read removes trailing blank viewport rows before slicing', async () => {
  assert.deepEqual(normalizeCapturedText('older\npwd\n/work\n$ \n\n  \n', 3), { text: 'pwd\n/work\n$ ', lines: 3 });
  const ssh = { readText: async (_p, _pw, lines) => {
    assert.equal(lines, 10000);
    return { text: 'older\npwd\n/work\n$ \n\n\n', target_pane: '%2', pane_current_command: 'bash' };
  }};
  const result = await service(ssh).read('Dev3', 3);
  assert.equal(result.text, 'pwd\n/work\n$ ');
  assert.equal(result.lines, 3);
});

test('SSH input operation completes on exit status without waiting for channel close', async () => {
  class ExitOnlyChannel extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); this.stderr.resume = () => {}; }
    resume() {}
    close() {}
    end() { setImmediate(() => this.emit('exit', 0)); }
  }
  class Client extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); }
    exec(_command, _options, callback) { callback(null, new ExitOnlyChannel()); }
    end() {}
  }
  const ssh = new TerminalSshService({ ClientClass: Client, commandTimeoutMs: 50 });
  const result = await ssh.writeTextFile(profile(), 'fixture', '/tmp/demo.txt', 'hello');
  assert.equal(result.written, true);
});

test('managed process byte cursor returns only unread bytes', async () => {
  const log = Buffer.from('first\nsecond\n');
  class Client extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); }
    exec(command, _options, callback) {
      const channel = new MockChannel();
      callback(null, channel);
      setImmediate(() => {
        if (command.startsWith('test -f ')) channel.emit('exit', 0);
        else if (command.startsWith('stat -c %s')) { channel.emit('data', Buffer.from(String(log.length) + '\n')); channel.emit('exit', 0); }
        else if (command.startsWith('dd if=')) { channel.emit('data', log.subarray(6)); channel.emit('exit', 0); }
        channel.emit('close', 0);
      });
    }
    end() {}
  }
  const ssh = new TerminalSshService({ ClientClass: Client });
  const result = await ssh.readManagedProcessLogs(profile(), 'fixture', 'brproc-0123456789abcdef', { cursor: 6, maxBytes: 1024 });
  assert.equal(result.text, 'second\n');
  assert.equal(result.next_cursor, log.length);
  assert.equal(result.eof, true);
});
