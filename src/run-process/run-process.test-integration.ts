// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DEFAULT_GRACE_PERIOD_SECONDS, ERRORS } from '../shared/index.js';

import { runProcess } from './run-process.js';

// the process groups and descendants these tests rely on exist only on POSIX
const IS_WINDOWS = process.platform === 'win32';

// the Node.js binary, so every child is a portable script
const NODE = process.execPath;

/**
 * Builds a child script that starts a grandchild, records both pids in a file and then runs the
 * provided code. The grandchild ignores SIGTERM only when asked, so a forced stop is exercised.
 */
const parentScript = (
  pidFile: string,
  code: string,
  grandchild: { stdio: 'ignore' | 'inherit'; detached?: boolean } = { stdio: 'ignore' },
): string => `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: '${grandchild.stdio}',
    detached: ${grandchild.detached === true},
  });
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  ${code}
`;

describe.skipIf(IS_WINDOWS)('runProcess', () => {
  let directory: string;
  let fileCounter = 0;
  const recordedPids: number[] = [];

  // a fresh pid file per test
  const nextPidFile = (): string => {
    fileCounter += 1;
    return join(directory, `pids-${fileCounter}.json`);
  };

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

  // reads the pids a child recorded, and remembers them for the cleanup
  const readPids = async (pidFile: string): Promise<{ child: number; grandchild: number }> => {
    await waitFor(() => existsSync(pidFile));
    const pids = JSON.parse(readFileSync(pidFile, 'utf-8'));
    recordedPids.push(pids.child, pids.grandchild);
    return pids;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'node-process-utils-'));
  });

  afterEach(() => {
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

  test('resolves with the output and the exit code of a successful run', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write("Hello"); process.stderr.write("World")'],
    });
    expect(result).toStrictEqual({
      exitCode: 0,
      signalCode: null,
      stdout: 'Hello',
      stderr: 'World',
      durationMs: expect.any(Number),
    });
  });

  test('resolves, rather than rejects, with a non-zero exit code', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stderr.write("failed"); process.exit(3)'],
    });
    expect(result.exitCode).toBe(3);
    expect(result.signalCode).toBeNull();
    expect(result.stderr).toBe('failed');
  });

  test('decodes multi-byte output split across chunks', async () => {
    const result = await runProcess({
      command: NODE,
      args: [
        '-e',
        'const b = Buffer.from("é🚀"); process.stdout.write(b.subarray(0, 3)); setTimeout(() => process.stdout.write(b.subarray(3)), 50)',
      ],
    });
    expect(result.stdout).toBe('é🚀');
  });

  test('writes the input to stdin', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      input: 'Hello from stdin',
    });
    expect(result.stdout).toBe('Hello from stdin');
  });

  test('resolves with the exit code when a child exits without reading a large input', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.exit(7)'],
      input: 'x'.repeat(8 * 1024 * 1024),
    });
    expect(result.exitCode).toBe(7);
  });

  test('rejects with PROCESS_START_FAILED for a command that does not exist', async () => {
    await expect(
      runProcess({ command: 'a-command-that-does-not-exist', args: [] }),
    ).rejects.toMatchObject({ code: ERRORS.PROCESS_START_FAILED });
  });

  test('rejects with the reason when the signal is already aborted', async () => {
    const reason = new Error('Stopped');
    await expect(
      runProcess({ command: NODE, args: ['-e', ''], signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  test('rejects with PROCESS_TIMED_OUT and stops the child and its grandchild', async () => {
    const pidFile = nextPidFile();
    await expect(
      runProcess({
        command: NODE,
        args: ['-e', parentScript(pidFile, 'setInterval(() => {}, 1000)')],
        timeoutSeconds: 1,
      }),
    ).rejects.toMatchObject({ code: ERRORS.PROCESS_TIMED_OUT });
    const pids = await readPids(pidFile);
    expect(isGone(pids.child)).toBe(true);
    expect(isGone(pids.grandchild)).toBe(true);
  });

  test('rejects with PROCESS_OUTPUT_TOO_LARGE and stops the child and its grandchild', async () => {
    const pidFile = nextPidFile();
    await expect(
      runProcess({
        command: NODE,
        args: [
          '-e',
          parentScript(
            pidFile,
            'process.stdout.write("x".repeat(5000)); setInterval(() => {}, 1000)',
          ),
        ],
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: ERRORS.PROCESS_OUTPUT_TOO_LARGE });
    const pids = await readPids(pidFile);
    expect(isGone(pids.child)).toBe(true);
    expect(isGone(pids.grandchild)).toBe(true);
  });

  test('rejects with the reason on abort and stops the child and its grandchild', async () => {
    const pidFile = nextPidFile();
    const controller = new AbortController();
    const reason = new Error('Stopped');
    const run = runProcess({
      command: NODE,
      args: ['-e', parentScript(pidFile, 'setInterval(() => {}, 1000)')],
      signal: controller.signal,
    });
    const pids = await readPids(pidFile);
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(isGone(pids.child)).toBe(true);
    expect(isGone(pids.grandchild)).toBe(true);
  });

  test('stops a child that ignores SIGTERM once the grace period has passed', async () => {
    const pidFile = nextPidFile();
    const startedAt = Date.now();
    await expect(
      runProcess({
        command: NODE,
        args: [
          '-e',
          parentScript(pidFile, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'),
        ],
        timeoutSeconds: 0.5,
      }),
    ).rejects.toMatchObject({ code: ERRORS.PROCESS_TIMED_OUT });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DEFAULT_GRACE_PERIOD_SECONDS * 1000);
    const pids = await readPids(pidFile);
    expect(isGone(pids.child)).toBe(true);
  }, 20_000);

  test('stops a grandchild that keeps stdout open after the child exits', async () => {
    const pidFile = nextPidFile();
    const result = await runProcess({
      command: NODE,
      args: [
        '-e',
        parentScript(pidFile, 'process.stdout.write("done"); process.exit(0)', {
          stdio: 'inherit',
        }),
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
    const pids = await readPids(pidFile);
    expect(isGone(pids.grandchild)).toBe(true);
  });

  test('rejects with PROCESS_TREE_SURVIVED when an unreachable descendant keeps stdout open', async () => {
    const pidFile = nextPidFile();
    const startedAt = Date.now();
    await expect(
      runProcess({
        command: NODE,
        args: [
          '-e',
          parentScript(pidFile, 'process.exit(0)', { stdio: 'inherit', detached: true }),
        ],
      }),
    ).rejects.toMatchObject({ code: ERRORS.PROCESS_TREE_SURVIVED });
    expect(Date.now() - startedAt).toBeLessThan((DEFAULT_GRACE_PERIOD_SECONDS + 3) * 1000);
    const pids = await readPids(pidFile);
    // the grandchild left the group with setsid, so the test stops it itself
    expect(isGone(pids.grandchild)).toBe(false);
  }, 20_000);
});
