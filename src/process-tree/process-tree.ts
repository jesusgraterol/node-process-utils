import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Exception } from 'error-message-utils';

import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  ERRORS,
  type IStartProcessOptions,
} from '../shared/index.js';

import {
  FORCED_STOP_SECONDS,
  STOP_POLL_INTERVAL_MILLISECONDS,
  WINDOWS_STOP_SECONDS,
} from './constants.js';

// whether the package runs on Windows, which has no process groups to signal
const IS_WINDOWS = process.platform === 'win32';

/**
 * Starts a long-running child that the caller owns, without a shell and, on POSIX, as the leader
 * of its own process group, so stopProcessTree can later stop it together with its descendants.
 * Because the child leads its own group, a terminal's Ctrl+C reaches only the parent: CLIs should
 * stop the child when they receive SIGINT or SIGTERM. A command that can't start emits an 'error'
 * event on the returned child.
 * @param command The executable to run.
 * @param args The arguments passed to the executable.
 * @param options? The working directory, the environment and the stdio configuration ('inherit' by default).
 * @returns The started child process.
 */
export const startProcess = (
  command: string,
  args: string[],
  options: IStartProcessOptions = {},
): ChildProcess =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
    detached: !IS_WINDOWS,
    windowsHide: true,
  });

/**
 * Checks whether a child process has exited and Node.js has processed its exit.
 * @param child The child process.
 * @returns True when the child has an exit code or a terminating signal.
 */
const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/**
 * Checks whether a process, or a process group when the target is negative, still exists.
 * @param target A pid, or a negated process-group id.
 * @returns True unless the target is gone.
 */
const exists = (target: number): boolean => {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    // EPERM means the target exists but belongs to another user
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Sends a signal and reports whether the target received it.
 * @param target A pid, or a negated process-group id.
 * @param signal The signal to send.
 * @returns False when the target doesn't exist or can't be signalled.
 */
const sendSignal = (target: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(target, signal);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Checks whether a child has exited and its process group, if it leads one, is gone.
 * @param child The child process.
 * @param pid The child's pid, which is also the id of the group it leads.
 * @returns True when nothing of the tree remains.
 */
const isTreeStopped = (child: ChildProcess, pid: number): boolean =>
  hasExited(child) && !exists(-pid);

/**
 * Signals the child's process group, or the child alone when it leads no group. A child that has
 * exited is never signalled by pid, because its pid may already belong to another process.
 * @param child The child process.
 * @param pid The child's pid.
 * @param signal The signal to send.
 */
const signalTree = (child: ChildProcess, pid: number, signal: NodeJS.Signals): void => {
  if (!sendSignal(-pid, signal) && !hasExited(child)) {
    sendSignal(pid, signal);
  }
};

/**
 * Polls a condition until it holds or the time runs out.
 * @param condition The condition to check.
 * @param milliseconds The maximum time to wait.
 * @returns A promise that resolves to whether the condition held in time.
 */
const waitFor = async (condition: () => boolean, milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) {
      return false;
    }
    // the checks run one after another by design
    // eslint-disable-next-line no-await-in-loop
    await sleep(STOP_POLL_INTERVAL_MILLISECONDS);
  }
  return true;
};

/**
 * Builds the error thrown when part of a process tree outlives the forced stop.
 * @param pid The child's pid.
 * @returns The error.
 */
const treeSurvived = (pid: number): Exception =>
  new Exception(
    `The process tree of pid ${pid} is still running after it was force-stopped.`,
    ERRORS.PROCESS_TREE_SURVIVED,
  );

/**
 * Stops a process tree on POSIX: SIGTERM to the group, then SIGKILL after the grace period.
 * @param child The child process.
 * @param pid The child's pid.
 * @param gracePeriodSeconds The seconds to wait after SIGTERM.
 * @returns A promise that resolves once the tree is gone.
 * @throws
 * - PROCESS_TREE_SURVIVED: The process tree is still running after it was force-stopped.
 */
const stopPosixTree = async (
  child: ChildProcess,
  pid: number,
  gracePeriodSeconds: number,
): Promise<void> => {
  const isStopped = (): boolean => isTreeStopped(child, pid);
  if (isStopped()) {
    return;
  }
  signalTree(child, pid, 'SIGTERM');
  if (await waitFor(isStopped, gracePeriodSeconds * 1000)) {
    return;
  }
  signalTree(child, pid, 'SIGKILL');
  if (await waitFor(isStopped, FORCED_STOP_SECONDS * 1000)) {
    return;
  }
  throw treeSurvived(pid);
};

/**
 * Stops a process tree on Windows with taskkill, which finds descendants by walking down from a
 * live root process. Descendants orphaned after the root exited can't be found this way.
 * @param child The child process.
 * @param pid The child's pid.
 * @returns A promise that resolves once the root process has exited.
 * @throws
 * - PROCESS_TREE_SURVIVED: The process tree is still running after it was force-stopped.
 */
const stopWindowsTree = async (child: ChildProcess, pid: number): Promise<void> => {
  if (hasExited(child)) {
    return;
  }
  // a failed taskkill is detected below, by the root that keeps running
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: WINDOWS_STOP_SECONDS * 1000, windowsHide: true },
      () => resolve(),
    );
  });
  if (!(await waitFor(() => hasExited(child), WINDOWS_STOP_SECONDS * 1000))) {
    throw treeSurvived(pid);
  }
};

/**
 * Stops a child started by startProcess or runProcess together with its descendants, and
 * resolves once they are gone. It resolves immediately for a child without a pid.
 *
 * On POSIX, it sends SIGTERM to the child's process group, waits up to the grace period, then
 * sends SIGKILL and waits up to two more seconds. It is designed for children that lead their own
 * process group, as startProcess and runProcess start them; for any other child, it signals the
 * child alone. Descendants that start their own session or process group, for example with
 * setsid, aren't stopped.
 *
 * On Windows, it runs taskkill /T /F, which reaches only descendants of a root process that is
 * still running: when the root has already exited, it resolves and orphaned descendants may
 * remain.
 * @param child The child process to stop.
 * @param gracePeriodSeconds? The seconds to wait after SIGTERM. Defaults to DEFAULT_GRACE_PERIOD_SECONDS.
 * @returns A promise that resolves once the process tree is gone.
 * @throws
 * - PROCESS_TREE_SURVIVED: The process tree is still running after it was force-stopped.
 */
export const stopProcessTree = async (
  child: ChildProcess,
  gracePeriodSeconds: number = DEFAULT_GRACE_PERIOD_SECONDS,
): Promise<void> => {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }
  if (IS_WINDOWS) {
    await stopWindowsTree(child, pid);
    return;
  }
  await stopPosixTree(child, pid, gracePeriodSeconds);
};
