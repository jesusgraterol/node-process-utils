import { spawn, type ChildProcess } from 'node:child_process';
import { Exception, extractMessage } from 'error-message-utils';

import { stopProcessTree } from '../process-tree/index.js';
import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ERRORS,
  type IProcessResult,
  type IRunProcessOptions,
} from '../shared/index.js';

import type { IRunOutcome } from './types.js';
import { IGNORED_STDIN_ERROR_CODES } from './constants.js';

/**
 * Builds the error thrown when a command can't start or its input can't be written.
 * @param command The command that failed.
 * @param cause The underlying error.
 * @returns The error.
 */
const startFailed = (command: string, cause: unknown): Exception =>
  new Exception(
    `Unable to start '${command}': ${extractMessage(cause)}`,
    ERRORS.PROCESS_START_FAILED,
    undefined,
    { cause },
  );

/**
 * Builds the error thrown when a process writes more output than allowed.
 * @param command The command that ran.
 * @param maxOutputBytes The allowed number of bytes.
 * @returns The error.
 */
const outputTooLarge = (command: string, maxOutputBytes: number): Exception =>
  new Exception(
    `The process '${command}' wrote more than ${maxOutputBytes} bytes of output.`,
    ERRORS.PROCESS_OUTPUT_TOO_LARGE,
  );

/**
 * Destroys the child's stdio streams, so pipes held by an unreachable process can't keep the
 * caller's event loop alive.
 * @param child The child process.
 */
const destroyStdio = (child: ChildProcess): void => {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
};

/**
 * Waits until the child's stdio streams have closed, for at most the provided time.
 * @param child The child process.
 * @param isClosed Whether the streams already closed.
 * @param milliseconds The maximum time to wait.
 * @returns A promise that resolves to whether the streams closed in time.
 */
const waitForClose = (
  child: ChildProcess,
  isClosed: () => boolean,
  milliseconds: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (isClosed()) {
      resolve(true);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, milliseconds);
    child.once('close', onClose);
  });

/**
 * Stops a child's process tree, destroying its stdio streams when that fails.
 * @param child The child process.
 * @returns A promise that resolves once the tree is gone.
 * @throws
 * - PROCESS_TREE_SURVIVED: The process tree is still running after it was force-stopped.
 */
const stopTree = async (child: ChildProcess): Promise<void> => {
  try {
    await stopProcessTree(child);
  } catch (error) {
    destroyStdio(child);
    throw error;
  }
};

/**
 * Runs a command to completion and resolves with its exit code, signal and output. It runs
 * without a shell and, on POSIX, as the leader of its own process group.
 *
 * Every exit resolves, whatever its code: callers decide which codes are acceptable, so process
 * output never ends up in an error message. The call rejects only when the command can't start,
 * the timeout passes, the output exceeds maxOutputBytes, or the signal aborts; in those cases the
 * process tree is stopped first, so the rejection can arrive up to the grace period plus two
 * seconds after the trigger.
 *
 * Input that the child never reads is discarded without an error. When the child exits,
 * descendants left in its process group are stopped. If one that couldn't be reached, such as a
 * descendant that left the group with setsid or one orphaned on Windows, keeps stdout or stderr
 * open for longer than the grace period, the call rejects instead of hanging.
 *
 * Because the child leads its own group, a terminal's Ctrl+C reaches only the parent: CLIs should
 * abort the signal when they receive SIGINT or SIGTERM.
 * @param options The command, its arguments, and the limits of the run.
 * @returns A promise that resolves with the exit code, the signal and the output.
 * @throws
 * - PROCESS_START_FAILED: Unable to start the command
 * - PROCESS_TIMED_OUT: The process didn't finish within the timeout
 * - PROCESS_OUTPUT_TOO_LARGE: The process wrote more output than allowed
 * - PROCESS_TREE_SURVIVED: The process tree is still running after it was force-stopped
 * - The signal's reason when the signal aborts.
 */
export const runProcess = async (options: IRunProcessOptions): Promise<IProcessResult> => {
  const {
    command,
    args,
    cwd,
    env,
    input,
    timeoutSeconds,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    signal,
  } = options;
  signal?.throwIfAborted();
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let isClosed = false;
  child.once('close', () => {
    isClosed = true;
  });

  // wait for the first of: exit, start failure, stdin failure, timeout, output overflow, abort
  const outcome = await new Promise<IRunOutcome>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve({ kind: 'failed', error: signal?.reason });
    };
    const settle = (value: IRunOutcome): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        settle({ kind: 'failed', error: outputTooLarge(command, maxOutputBytes) });
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => settle({ kind: 'failed', error: startFailed(command, error) }));
    child.once('exit', (exitCode, signalCode) => settle({ kind: 'exited', exitCode, signalCode }));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (!IGNORED_STDIN_ERROR_CODES.includes(error.code ?? '')) {
        settle({ kind: 'failed', error: startFailed(command, error) });
      }
    });
    if (timeoutSeconds !== undefined) {
      timer = setTimeout(
        () =>
          settle({
            kind: 'failed',
            error: new Exception(
              `The process '${command}' didn't finish within ${timeoutSeconds} seconds.`,
              ERRORS.PROCESS_TIMED_OUT,
            ),
          }),
        timeoutSeconds * 1000,
      );
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(input);
  });

  // a failed run stops the whole tree before it rejects
  if (outcome.kind === 'failed') {
    await stopTree(child);
    destroyStdio(child);
    throw outcome.error;
  }

  // the child exited: stop the descendants left in its group, then wait for its output to close
  await stopTree(child);
  if (!(await waitForClose(child, () => isClosed, DEFAULT_GRACE_PERIOD_SECONDS * 1000))) {
    destroyStdio(child);
    throw new Exception(
      `A process started by '${command}' kept its output open after it exited.`,
      ERRORS.PROCESS_TREE_SURVIVED,
    );
  }
  if (outputBytes > maxOutputBytes) {
    throw outputTooLarge(command, maxOutputBytes);
  }
  return {
    exitCode: outcome.exitCode,
    signalCode: outcome.signalCode,
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: Buffer.concat(stderr).toString('utf-8'),
    durationMs: Math.round(performance.now() - startedAt),
  };
};
