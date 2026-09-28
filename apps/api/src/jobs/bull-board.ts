import { INestApplication, Logger } from '@nestjs/common';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { safeEqual } from '../common/utils/crypto';
import { env, isProd } from '../config/env';
import { QueueService } from './queue.service';

const BASE_PATH = '/admin/queues';

/**
 * Mounts the Bull Board queue dashboard behind HTTP basic auth. In production it is only
 * enabled when BULL_BOARD_PASSWORD is set; development falls back to admin/admin.
 */
export function mountBullBoard(app: INestApplication) {
  const password = env().BULL_BOARD_PASSWORD ?? (isProd() ? undefined : 'admin');
  if (!password) return;
  const user = env().BULL_BOARD_USER;
  const adapter = new ExpressAdapter();
  adapter.setBasePath(BASE_PATH);
  createBullBoard({ queues: app.get(QueueService).allQueues().map((q) => new BullMQAdapter(q)), serverAdapter: adapter });
  app.use(BASE_PATH, (req: any, res: any, next: () => void) => {
    const [scheme, encoded] = String(req.headers.authorization ?? '').split(' ');
    const [u, p] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':') : [];
    if (u && p && safeEqual(u, user) && safeEqual(p, password)) return next();
    res.set('WWW-Authenticate', 'Basic realm="TherapyOS queues"').status(401).send('Authentication required');
  });
  app.use(BASE_PATH, adapter.getRouter());
  new Logger('BullBoard').log(`Queue dashboard at ${env().API_URL}${BASE_PATH}`);
}
