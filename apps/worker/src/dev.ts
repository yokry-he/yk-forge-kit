import { loadWorkerDevelopmentEnv } from './dev-env';
import { reportWorkerStartFailure } from './diagnostics';

async function dev() {
  loadWorkerDevelopmentEnv();
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    console.log('worker_disabled: dev requires DATABASE_URL and REDIS_URL');
    return;
  }
  const { main } = await import('./main');
  await main({ development: process.env.NODE_ENV !== 'production' });
}
void dev().catch(reportWorkerStartFailure);
