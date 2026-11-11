'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function fail(code: string, message: string) { return Object.assign(new Error(message), {code}); }

function readText(filePath: string) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}

function isUnsafeDirectory(target: string) {
  if (!target) return true;
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  return resolved === root || resolved === home || resolved === path.dirname(home);
}

function buildCleanupPlan({ runtimeDir, workerHome }: {runtimeDir: string; workerHome: string}) {
  const resolvedRuntime = path.resolve(runtimeDir);
  if (path.basename(resolvedRuntime) !== 'current') {
    throw fail('WORKER_UNINSTALL_UNSAFE', 'Remote uninstall is allowed only for a verified installer-managed current directory.');
  }

  const installRoot = path.dirname(resolvedRuntime);
  const resolvedHome = path.resolve(workerHome);
  if (isUnsafeDirectory(installRoot) || isUnsafeDirectory(resolvedHome)) {
    throw fail('WORKER_UNINSTALL_UNSAFE', 'Refusing to remove an unsafe worker directory.');
  }

  const recordedRoot = readText(path.join(resolvedHome, 'install-root'));
  if (recordedRoot && path.resolve(recordedRoot) !== installRoot) {
    throw fail('WORKER_UNINSTALL_UNSAFE', 'Recorded install root does not match the running worker installation.');
  }

  const config = readJson(path.join(resolvedHome, 'config.json')) || {};
  const recordedBin = readText(path.join(resolvedHome, 'bin-path'));
  const defaultBin = path.join(os.homedir(), '.local', 'bin', 'bot-report-worker');
  const binPath = path.resolve(recordedBin || defaultBin);

  let removeBin = false;
  try {
    const stat = fs.lstatSync(binPath);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(binPath);
      const relative = path.relative(installRoot, target);
      removeBin = relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    }
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  return {
    install_root: installRoot,
    worker_home: resolvedHome,
    bin_path: binPath,
    remove_bin: removeBin,
    tmux_session: config.tmux_created_by_worker ? String(config.tmux_session || '') : ''
  };
}

function applyCleanupPlan(plan: ReturnType<typeof buildCleanupPlan>) {
  if (plan.tmux_session && /^[A-Za-z0-9_.-]{1,80}$/.test(plan.tmux_session)) {
    spawnSync('tmux', ['kill-session', '-t', `=${plan.tmux_session}`], { stdio: 'ignore' });
  }
  if (plan.remove_bin) {
    try { fs.unlinkSync(plan.bin_path); } catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  fs.rmSync(plan.worker_home, { recursive: true, force: true });
  fs.rmSync(plan.install_root, { recursive: true, force: true });
  return {
    code: 'UNINSTALLED',
    installation_removed: true,
    local_state_removed: true,
    bin_removed: Boolean(plan.remove_bin),
    tmux_removed: Boolean(plan.tmux_session)
  };
}

export = {buildCleanupPlan, applyCleanupPlan};
