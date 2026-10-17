// the bytes stdout and stderr can hold together when runProcess gets no maxOutputBytes (1 MiB)
export const DEFAULT_MAX_OUTPUT_BYTES = 1048576;

// the seconds stopProcessTree waits after SIGTERM before it sends SIGKILL
export const DEFAULT_GRACE_PERIOD_SECONDS = 5;
