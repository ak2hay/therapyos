import '../src/bootstrap-env';

// Integration tests run against a dedicated database so they never touch development data.
process.env.NODE_ENV = 'test';
process.env.DISABLE_WORKERS = 'true';
process.env.RUN_WORKER_IN_API = 'false';
process.env.NOTIFICATIONS_SUPPRESS = 'true';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else if (process.env.DATABASE_URL && !/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
}
