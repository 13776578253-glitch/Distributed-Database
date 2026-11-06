import { describe, expect, it } from 'vitest';
import { isOperation } from '../src/contracts/history.ts';

describe('operation contract', () => {
  it('accepts every operation and a stored JSON null', () => {
    expect(isOperation({ type: 'get', key: 'x' })).toBe(true);
    expect(isOperation({ type: 'delete', key: 'x' })).toBe(true);
    expect(isOperation({ type: 'put', key: 'x', value: null })).toBe(true);
  });

  it('rejects operations outside the supported key and value shapes', () => {
    expect(isOperation({ type: 'get', key: '' })).toBe(false);
    expect(isOperation({ type: 'put', key: 'x', value: {} })).toBe(false);
    expect(isOperation({ type: 'put', key: 'x', value: Infinity })).toBe(false);
    expect(isOperation({ type: 'unknown', key: 'x' })).toBe(false);
  });
});
