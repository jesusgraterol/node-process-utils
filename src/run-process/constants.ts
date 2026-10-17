// stdin errors from a child that exits or closes stdin before reading all of its input
export const IGNORED_STDIN_ERROR_CODES = ['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED'];
