import { describe, expect, it } from 'vitest';
import { requireDisposableTestDatabase } from '../src/integration-guard';

const url = 'mysql://forgekit_test:example@127.0.0.1:33306/forgekit_test';

describe('disposable MySQL integration safety gate', () => {
  it('only accepts an explicitly enabled loopback test database', () => {
    expect(requireDisposableTestDatabase({ FORGEKIT_DB_INTEGRATION: '1', DATABASE_URL: url })).toBe(url);
  });

  it.each([
    { FORGEKIT_DB_INTEGRATION: '0', DATABASE_URL: url },
    { FORGEKIT_DB_INTEGRATION: '1', DATABASE_URL: 'mysql://root:secret@127.0.0.1:3306/forgekit_test' },
    { FORGEKIT_DB_INTEGRATION: '1', DATABASE_URL: 'mysql://forgekit_test:secret@127.0.0.1:33306/forgekit' },
    { FORGEKIT_DB_INTEGRATION: '1', DATABASE_URL: 'mysql://forgekit_test:secret@db.internal:3306/forgekit_test' },
    { FORGEKIT_DB_INTEGRATION: '1', DATABASE_URL: 'mysql://forgekit_test:secret@127.0.0.1:3307/forgekit_test' },
  ])('rejects non-disposable targets without disclosing their credentials', (env) => {
    expect(() => requireDisposableTestDatabase(env)).toThrow();
  });
});
