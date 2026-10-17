import type { StdioOptions } from 'node:child_process';

// the options accepted by runProcess
export type IRunProcessOptions = {
  // the executable to run, without a shell
  command: string;

  // the arguments passed to the executable
  args: string[];

  // the working directory. Defaults to the current one
  cwd?: string;

  // the environment variables. Defaults to process.env
  env?: NodeJS.ProcessEnv;

  // the data written to the process's stdin before it is closed
  input?: string | Uint8Array;

  // the seconds after which the process tree is stopped and the call rejects
  timeoutSeconds?: number;

  // the bytes stdout and stderr can hold together. Defaults to DEFAULT_MAX_OUTPUT_BYTES
  maxOutputBytes?: number;

  // stops the process tree and rejects with the signal's reason when it aborts
  signal?: AbortSignal;
};

// the outcome of a process that ran to completion
export type IProcessResult = {
  // the exit code, or null when a signal ended the process
  exitCode: number | null;

  // the signal that ended the process, or null when it exited on its own
  signalCode: NodeJS.Signals | null;

  // the output, decoded as UTF-8
  stdout: string;
  stderr: string;

  // the milliseconds between the start and the end of the run
  durationMs: number;
};

// the options accepted by startProcess
export type IStartProcessOptions = {
  // the working directory. Defaults to the current one
  cwd?: string;

  // the environment variables. Defaults to process.env
  env?: NodeJS.ProcessEnv;

  // the stdio configuration. Defaults to 'inherit'
  stdio?: StdioOptions;
};
