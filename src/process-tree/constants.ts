// the seconds stopProcessTree keeps checking after SIGKILL before it gives up
export const FORCED_STOP_SECONDS = 2;

// the seconds taskkill may run, and then the seconds to wait for the exit, on Windows
export const WINDOWS_STOP_SECONDS = 10;

// the milliseconds between checks of whether a process tree is gone
export const STOP_POLL_INTERVAL_MILLISECONDS = 50;
