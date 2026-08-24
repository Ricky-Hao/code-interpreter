import { describe, expect, test } from 'bun:test';
import { legacyPackagesDirectory, safeBoolean } from './config';

describe('safeBoolean', () => {
  test.each([
    ['false', false],
    ['False', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
  ])('parses %s', (raw, expected) => {
    expect(safeBoolean(raw, !expected)).toBe(expected);
  });

  test('uses the fail-closed fallback for missing or invalid values', () => {
    expect(safeBoolean(undefined, true)).toBe(true);
    expect(safeBoolean('', true)).toBe(true);
    expect(safeBoolean('typo', true)).toBe(true);
  });
});

describe('legacy package directory fallback', () => {
  test('preserves custom legacy data directories', () => {
    expect(legacyPackagesDirectory('/custom/data')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/custom/data/packages')).toBe('/custom/data/packages');
    expect(legacyPackagesDirectory('/')).toBe('/packages');
  });

  test('ignores empty legacy data directories', () => {
    expect(legacyPackagesDirectory(undefined)).toBeUndefined();
    expect(legacyPackagesDirectory('   ')).toBeUndefined();
  });
});
