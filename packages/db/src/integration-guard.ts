/** A hard gate: live integration tests must never target arbitrary application databases. */
export function requireDisposableTestDatabase(env: Record<string, string | undefined>): string {
  if (env.FORGEKIT_DB_INTEGRATION !== '1') {
    throw new Error('未设置 FORGEKIT_DB_INTEGRATION=1，拒绝执行集成数据库操作。');
  }
  if (!env.DATABASE_URL) throw new Error('集成测试缺少 DATABASE_URL。');
  let target: URL;
  try { target = new URL(env.DATABASE_URL); }
  catch { throw new Error('集成测试数据库地址无效。'); }
  if (target.protocol !== 'mysql:' || target.pathname !== '/forgekit_test' ||
      !['127.0.0.1', 'localhost'].includes(target.hostname) ||
      !['3306', '33306'].includes(target.port) || target.username !== 'forgekit_test' || !target.password) {
    throw new Error('集成测试只能连接回环地址的 forgekit_test 数据库与 forgekit_test 账号。');
  }
  return env.DATABASE_URL;
}
