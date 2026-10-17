// @vitest-environment node
import { describe, expect, test } from 'vitest';

import * as publicApi from './index.js';

describe('public API', () => {
  test('exports exactly the documented functions and constants', () => {
    expect(Object.keys(publicApi).sort()).toStrictEqual([
      'DEFAULT_GRACE_PERIOD_SECONDS',
      'DEFAULT_MAX_OUTPUT_BYTES',
      'runProcess',
      'startProcess',
      'stopProcessTree',
    ]);
    expect(publicApi.DEFAULT_MAX_OUTPUT_BYTES).toBe(1048576);
    expect(publicApi.DEFAULT_GRACE_PERIOD_SECONDS).toBe(5);
  });
});
