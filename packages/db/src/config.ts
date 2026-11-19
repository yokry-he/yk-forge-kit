export function validateDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL 未配置。');
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('DATABASE_URL 不是有效的连接地址。'); }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || !parsed.username || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('DATABASE_URL 必须是 mysql://user:password@host:port/database 格式。');
  }
  if (!parsed.password) throw new Error('DATABASE_URL 缺少密码。');
  return value;
}
