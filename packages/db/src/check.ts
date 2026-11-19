import 'dotenv/config';
import { createDatabaseClient } from './index';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL 未配置；未进行连接检查。');
  const client = createDatabaseClient(connectionString);
  try {
    await client.ping();
    console.log('MySQL 连接检查成功（未执行数据修改）。');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'MySQL 连接失败');
  process.exitCode = 1;
});
