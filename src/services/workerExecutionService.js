const workerConnectionBroker = require('./workerConnectionBroker');

function workerExecutionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class WorkerExecutionService {
  constructor({ broker = workerConnectionBroker } = {}) {
    this.broker = broker;
  }

  workerId(profile) {
    if (!profile?.worker_id) throw workerExecutionError('WORKER_PROFILE_INVALID', 'Worker profile has no worker identity.');
    return profile.worker_id;
  }

  async testConnection(profile) {
    const inspection = await this.inspectProfile(profile);
    return { code: 'TEST_OK', ...inspection };
  }

  shellKey(profile) {
    if (!profile?.id) throw workerExecutionError('WORKER_PROFILE_INVALID', 'Worker profile has no profile identity.');
    return `profile:${profile.id}`;
  }

  inspectProfile(profile) {
    return this.broker.dispatch(this.workerId(profile), 'shell.inspect', {
      session_key: this.shellKey(profile)
    }, { timeoutMs: 10_000 });
  }

  sendText(profile, _password, text, { submit = true } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'shell.send', {
      session_key: this.shellKey(profile),
      text,
      submit
    }, { timeoutMs: 10_000 });
  }

  readText(profile, _password, lines = 200) {
    return this.broker.dispatch(this.workerId(profile), 'shell.read', {
      session_key: this.shellKey(profile),
      lines
    }, { timeoutMs: 10_000 });
  }

  sendInterrupt(profile) {
    return this.broker.dispatch(this.workerId(profile), 'shell.interrupt', {
      session_key: this.shellKey(profile)
    }, { timeoutMs: 10_000 });
  }

  execWorkspaceCommand(profile, _password, command, { cwd = null, runAs = null, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'workspace.exec', {
      command,
      cwd,
      run_as: runAs,
      timeout_ms: timeoutMs,
      max_output_bytes: maxOutputBytes
    }, { timeoutMs });
  }

  collectArtifact(profile, _password, artifactPath, { maxBytes = 2 * 1024 * 1024, runAs = null } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'artifact.collect', {
      path: artifactPath,
      max_bytes: maxBytes,
      run_as: runAs
    }, { timeoutMs: 30_000 });
  }

  writeTextFile(profile, _password, filePath, content, { createDirs = false, runAs = null } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'file.write', {
      path: filePath,
      content,
      create_dirs: Boolean(createDirs),
      run_as: runAs
    }, { timeoutMs: 30_000 });
  }

  startManagedProcess(profile, _password, command, { cwd = null, runAs = null } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'process.start', {
      command,
      cwd,
      run_as: runAs
    }, { timeoutMs: 30_000 });
  }

  getManagedProcessStatus(profile, _password, processId, { lines = 200 } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'process.status', {
      process_id: processId,
      lines
    }, { timeoutMs: 10_000 });
  }

  readManagedProcessLogs(profile, _password, processId, { cursor = 0, maxBytes = 64 * 1024 } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'process.logs', {
      process_id: processId,
      cursor,
      max_bytes: maxBytes
    }, { timeoutMs: 10_000 });
  }

  stopManagedProcess(profile, _password, processId, { force = true, graceMs = 1000, lines = 200 } = {}) {
    return this.broker.dispatch(this.workerId(profile), 'process.stop', {
      process_id: processId,
      force,
      grace_ms: graceMs,
      lines
    }, { timeoutMs: Math.min(30_000, Math.max(10_000, Number(graceMs) + 5_000)) });
  }
}

module.exports = new WorkerExecutionService();
module.exports.WorkerExecutionService = WorkerExecutionService;
module.exports.workerExecutionError = workerExecutionError;
