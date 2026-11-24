import { loadWorkerDevelopmentEnv } from './dev-env';
loadWorkerDevelopmentEnv();
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.log('worker_disabled: dev requires DATABASE_URL and REDIS_URL');
} else {
  void import('./main');
}
