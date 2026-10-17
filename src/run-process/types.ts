// how a run ended, before its output is collected
export type IRunOutcome =
  | {
      // the process exited on its own or because of a signal
      kind: 'exited';
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }
  | {
      // the run failed; the process tree must be stopped before the error is thrown
      kind: 'failed';
      error: unknown;
    };
