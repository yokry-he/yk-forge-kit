import { expect, it } from 'vitest';
import { API_VERSION } from '../src/index';

it('exports a stable API version contract', () => {
  expect(API_VERSION).toBe('v1');
});
