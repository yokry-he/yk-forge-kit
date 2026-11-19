import { describe, expect, it } from 'vitest';
import { validateDatabaseUrl } from '../src/config';

describe('MySQL configuration', () => {
  it('accepts a valid MySQL URL', () => {
    expect(validateDatabaseUrl('mysql://forgekit:secret@127.0.0.1:3306/forgekit')).toContain('/forgekit');
  });
  it.each(['', 'postgres://user:pass@localhost/db', 'mysql://localhost/db', 'mysql://user@localhost/db', 'mysql://user:pass@localhost/'])('rejects invalid connections without echoing credentials', (url) => {
    expect(() => validateDatabaseUrl(url)).toThrow();
  });
});
