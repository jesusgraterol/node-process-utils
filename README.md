# Node Process Utils

The `node-process-utils` package runs child processes with bounded time and output, and stops the process trees it owns. It covers the mechanics every tool that spawns processes needs: no shell, a cap on collected output, timeouts and abort signals, and shutdown of the child together with its descendants.

Exit codes are returned rather than thrown, so callers decide which codes are acceptable and process output never ends up in an error message. Policies that depend on the caller, such as Git environment variables, credential handling or redacting diagnostics, stay in the caller's code.

The package runs on Node.js 24 and later.

</br>

## Getting Started

Install the package:

```bash
npm i -S node-process-utils
```

### Examples

Run a command and check its exit code:

```typescript
import { runProcess } from 'node-process-utils';

const { exitCode, stdout } = await runProcess({
  command: 'git',
  args: ['rev-parse', 'HEAD'],
  cwd: '/path/to/repository',
  timeoutSeconds: 30,
});

if (exitCode !== 0) {
  throw new Error(`git rev-parse failed with exit code ${exitCode}`);
}
console.log(stdout.trim()); // '4c0e2814b449d5c1cee5012f7f46fb9fb1c21df0'
```

Stop the run when a CLI receives Ctrl+C. The child leads its own process group, so the terminal's signal reaches only your process:

```typescript
import { runProcess } from 'node-process-utils';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Interrupted')));
process.once('SIGTERM', () => controller.abort(new Error('Terminated')));

await runProcess({ command: 'npm', args: ['test'], signal: controller.signal });
```

Start a long-running process and stop it, with its descendants, when you are done:

```typescript
import { startProcess, stopProcessTree } from 'node-process-utils';

const server = startProcess('node', ['server.js'], { env: { ...process.env, PORT: '3000' } });
// ...
await stopProcessTree(server);
```

<br/>

## API Reference

<details>
  <summary><code>runProcess</code></summary>
  <br/>

  Runs one command to completion, without a shell and, on POSIX, as the leader of its own process group. It resolves with an `IProcessResult`: the exit code, the terminating signal, stdout and stderr decoded as UTF-8, and the duration in milliseconds.

  - **Exit codes:** every exit resolves, whatever its code.
  - **Input:** `input` is written to stdin, which is then closed. Input that the child never reads, because it exits first, is discarded without an error.
  - **Output:** stdout and stderr together can hold at most `maxOutputBytes` bytes (`DEFAULT_MAX_OUTPUT_BYTES`, 1 MiB, by default).
  - **Descendants:** when the child exits, descendants left in its process group are stopped. If a descendant that couldn't be reached keeps stdout or stderr open for longer than the grace period, the call rejects with `PROCESS_TREE_SURVIVED` instead of hanging. Examples are a descendant that left the group with `setsid`, or one orphaned on Windows.
  - **Rejections:** the call rejects only in these cases, and stops the process tree first, so the rejection can arrive up to the grace period plus two seconds after the trigger:
    - `PROCESS_START_FAILED` when the command can't start, with the underlying error as `cause`
    - `PROCESS_TIMED_OUT` when `timeoutSeconds` passes
    - `PROCESS_OUTPUT_TOO_LARGE` when the output exceeds `maxOutputBytes`
    - the signal's reason when `signal` aborts
    - `PROCESS_TREE_SURVIVED` when the process tree can't be stopped
  - **Ctrl+C:** because the child leads its own group, a terminal's Ctrl+C reaches only the parent. CLIs should abort the signal on `SIGINT` and `SIGTERM`, as in the example above.

  ```typescript
  import { runProcess } from 'node-process-utils';

  await runProcess({
    command: 'node',
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    input: 'Hello World!',
  });
  // {
  //   exitCode: 0,
  //   signalCode: null,
  //   stdout: 'Hello World!',
  //   stderr: '',
  //   durationMs: 41
  // }
  ```
  <br/>
</details>

<details>
  <summary><code>startProcess</code></summary>
  <br/>

  Starts a long-running child that you own and returns its `ChildProcess` synchronously. It runs without a shell, with `stdio` set to `'inherit'` by default, and, on POSIX, as the leader of its own process group, so `stopProcessTree` can stop it together with its descendants. A command that can't start emits an `'error'` event on the returned child.

  ```typescript
  import { startProcess } from 'node-process-utils';

  const watcher = startProcess('npm', ['run', 'watch'], { cwd: 'packages/app' });
  watcher.once('exit', (code) => console.log(`watch exited with ${code}`));
  ```
  <br/>
</details>

<details>
  <summary><code>stopProcessTree</code></summary>
  <br/>

  Stops a child together with its descendants and resolves once they are gone. It resolves immediately for a child without a pid.

  - **POSIX:** it sends `SIGTERM` to the child's process group, waits up to `gracePeriodSeconds` (`DEFAULT_GRACE_PERIOD_SECONDS`, 5, by default), then sends `SIGKILL` and waits up to two more seconds. It resolves only once the child has exited and its group is gone.
  - **Precondition:** it is designed for children from `startProcess` or `runProcess`, which lead their own process group. For any other child, it stops the child alone.
  - **Windows:** it runs `taskkill /PID <pid> /T /F` and waits up to 10 seconds for the exit. `taskkill` finds descendants by walking down from a root process that is still running, so when the root has already exited, the call resolves and orphaned descendants may remain.
  - **Limits:** descendants that start their own session or process group, for example with `setsid`, aren't stopped on POSIX, and orphaned descendants aren't stopped on Windows.
  - **Failure:** it rejects with `PROCESS_TREE_SURVIVED` when anything it can observe outlives the forced stop.

  ```typescript
  import { startProcess, stopProcessTree } from 'node-process-utils';

  const child = startProcess('node', ['server.js']);
  await stopProcessTree(child, 10);
  ```
  <br/>
</details>

<br/>

## Constants

<details>
  <summary><code>DEFAULT_MAX_OUTPUT_BYTES</code></summary>
  <br/>

  The number of bytes stdout and stderr can hold together when `runProcess` gets no `maxOutputBytes`.

  ```typescript
  const DEFAULT_MAX_OUTPUT_BYTES = 1048576; // 1 MiB
  ```
  <br/>
</details>

<details>
  <summary><code>DEFAULT_GRACE_PERIOD_SECONDS</code></summary>
  <br/>

  The number of seconds `stopProcessTree` waits after `SIGTERM` before it sends `SIGKILL`. `runProcess` uses it too.

  ```typescript
  const DEFAULT_GRACE_PERIOD_SECONDS = 5;
  ```
  <br/>
</details>

<br/>

## Types

<details>
  <summary><code>IRunProcessOptions</code></summary>
  <br/>

  The options accepted by `runProcess`.

  ```typescript
  type IRunProcessOptions = {
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
  ```
  <br/>
</details>

<details>
  <summary><code>IProcessResult</code></summary>
  <br/>

  The outcome of a process that ran to completion.

  ```typescript
  type IProcessResult = {
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
  ```
  <br/>
</details>

<details>
  <summary><code>IStartProcessOptions</code></summary>
  <br/>

  The options accepted by `startProcess`.

  ```typescript
  type IStartProcessOptions = {
    // the working directory. Defaults to the current one
    cwd?: string;

    // the environment variables. Defaults to process.env
    env?: NodeJS.ProcessEnv;

    // the stdio configuration. Defaults to 'inherit'
    stdio?: StdioOptions;
  };
  ```
  <br/>
</details>

<br/>

## Built With

- TypeScript
- `node:child_process`

<br/>

## Running the Tests

The integration tests start real processes and run on POSIX systems; the process-group tests are skipped on Windows.

```bash
# unit and integration tests
npm run test

# tests, type checking, linting and formatting
npm run verify

# unit tests
npm run test:unit

# integration tests
npm run test:integration
```

<br/>

## License

[MIT](https://choosealicense.com/licenses/mit/)
