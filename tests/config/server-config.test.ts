/**
 * @fileoverview Server config bounds: each numeric env var is held to the range
 * its consumer can use, so an out-of-range value stops startup naming the
 * variable instead of failing calls later; EIA_CLAMP_LIMITS parses as a strict
 * boolean and is readable without the API key.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetServerConfig, getClampLimits, getServerConfig } from '@/config/server-config.js';

beforeEach(() => {
  vi.stubEnv('EIA_API_KEY', 'test-key');
  _resetServerConfig();
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetServerConfig();
});

/** The config parsed afresh with `name` set to `value`. */
function parseWith(name: string, value: string) {
  vi.stubEnv(name, value);
  _resetServerConfig();
  return getServerConfig();
}

describe('numeric env bounds', () => {
  it.each([
    ['EIA_DATASET_TTL_SECONDS', 'datasetTtlSeconds', 86_400, 31_536_000],
    ['EIA_CANVAS_MAX_ROWS', 'canvasMaxRows', 25_000, 250_000],
    ['EIA_FACET_VALUE_CAP', 'facetValueCap', 50, 1_000],
  ] as const)('%s defaults to %s → %i and accepts up to %i', (name, key, fallback, max) => {
    vi.stubEnv(name, undefined);
    _resetServerConfig();
    expect(getServerConfig()[key]).toBe(fallback);
    expect(parseWith(name, String(max))[key]).toBe(max);
    expect(parseWith(name, '1')[key]).toBe(1);
  });

  it.each([
    ['EIA_DATASET_TTL_SECONDS', '31536001'],
    ['EIA_CANVAS_MAX_ROWS', '250001'],
    ['EIA_FACET_VALUE_CAP', '1001'],
    ['EIA_DATASET_TTL_SECONDS', '0'],
    ['EIA_CANVAS_MAX_ROWS', '-5'],
    ['EIA_FACET_VALUE_CAP', '2.5'],
  ])('rejects %s=%s at startup, naming the variable', (name, value) => {
    expect(() => parseWith(name, value)).toThrow(name);
  });
});

describe('EIA_CLAMP_LIMITS', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['false', false],
    ['0', false],
  ])('reads %j as %s', (value, expected) => {
    vi.stubEnv('EIA_CLAMP_LIMITS', value);
    _resetServerConfig();
    expect(getClampLimits()).toBe(expected);
    expect(getServerConfig().clampLimits).toBe(expected);
  });

  it('rejects a value that is not a boolean, naming the variable', () => {
    vi.stubEnv('EIA_CLAMP_LIMITS', 'maybe');
    _resetServerConfig();
    expect(() => getClampLimits()).toThrow('EIA_CLAMP_LIMITS');
    expect(() => getServerConfig()).toThrow('EIA_CLAMP_LIMITS');
  });

  it('is readable without EIA_API_KEY, which the count inputs need while tools are listed', () => {
    vi.stubEnv('EIA_API_KEY', undefined);
    vi.stubEnv('EIA_CLAMP_LIMITS', 'false');
    _resetServerConfig();
    expect(() => getServerConfig()).toThrow('EIA_API_KEY');
    expect(getClampLimits()).toBe(false);
  });
});
