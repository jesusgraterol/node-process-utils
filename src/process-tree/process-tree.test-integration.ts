// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { startProcess, stopProcessTree } from './process-tree.js';

// process groups exist only on POSIX
const IS_WINDOWS = process.platform === 'win32';

// a child script that ignores SIGTERM and starts a grandchild that ignores it too
const STUBBORN_PARENT = (pidFile: string): string => `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  process.on('SIGTERM', () => {});
  const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
`;

describe.skipIf(IS_WINDOWS)('startProcess & stopProcessTree', () => {
  let directory: string;
  const children: ChildProcess[] = [];
  const recordedPids: number[] = [];

  // whether a process is gone
  const isGone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };

  // polls a condition with a deadline instead of sleeping for a fixed time
  const waitFor = async (condition: () => boolean, milliseconds = 5000): Promise<void> => {
    const deadline = Date.now() + milliseconds;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('The condition was not met in time.');
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(20);
    }
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'node-process-utils-'));
  });

  afterEach(() => {
    children.splice(0).forEach((child) => child.kill('SIGKILL'));
    recordedPids.splice(0).forEach((pid) => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        // the process is already gone
      }
    });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('starts a child that leads its own process group', async () => {
    const child = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(() => child.pid !== undefined);
    expect(() => process.kill(-child.pid!, 0)).not.toThrow();
    await stopProcessTree(child);
    expect(child.signalCode).toBe('SIGTERM');
  });

  test('stops a child and its grandchild with SIGKILL after the grace period', async () => {
    const pidFile = join(directory, 'stubborn.json');
    const child = startProcess(process.execPath, ['-e', STUBBORN_PARENT(pidFile)], {
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(() => existsSync(pidFile));
    const pids = JSON.parse(readFileSync(pidFile, 'utf-8'));
    recordedPids.push(pids.grandchild);

    const startedAt = Date.now();
    await stopProcessTree(child, 1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
    expect(child.signalCode).toBe('SIGKILL');
    expect(isGone(pids.child)).toBe(true);
    expect(isGone(pids.grandchild)).toBe(true);
  });

  test('resolves immediately for a child that has already exited', async () => {
    const child = startProcess(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => {
      child.once('exit', resolve);
    });
    const startedAt = Date.now();
    await stopProcessTree(child);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test('resolves immediately for a child that never started', async () => {
    const child = startProcess('a-command-that-does-not-exist', [], { stdio: 'ignore' });
    const error = new Promise((resolve) => {
      child.once('error', resolve);
    });
    await expect(stopProcessTree(child)).resolves.toBeUndefined();
    await error;
  });

  test('stops a child without its own process group, only once it has exited', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    children.push(child);
    await waitFor(() => child.pid !== undefined);
    await sleep(200);
    await stopProcessTree(child, 0.5);
    expect(child.signalCode).toBe('SIGKILL');
    expect(isGone(child.pid!)).toBe(true);
  });
});
