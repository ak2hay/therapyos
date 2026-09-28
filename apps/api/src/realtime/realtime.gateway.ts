import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { env } from '../config/env';
import type { JwtPrincipal } from '../common/decorators';
import { AuthzService } from '../core/authz.service';

const CHANNEL = 'therapyos:realtime';

interface RealtimeMessage {
  room: string;
  event: string;
  data: unknown;
}

export const rooms = {
  branch: (id: string) => `branch:${id}`,
  tenant: (id: string) => `tenant:${id}`,
  user: (id: string) => `user:${id}`,
  therapist: (id: string) => `therapist:${id}`,
};

/**
 * Publishes realtime events through Redis pub/sub so that any process (API instances or the
 * worker) can reach sockets connected to any API instance.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private pub?: Redis;

  emit(room: string, event: string, data: unknown) {
    this.pub ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    void this.pub.publish(CHANNEL, JSON.stringify({ room, event, data } satisfies RealtimeMessage)).catch(() => undefined);
  }

  toBranch(branchId: string, event: string, data: unknown) {
    this.emit(rooms.branch(branchId), event, data);
  }

  toUser(userId: string, event: string, data: unknown) {
    this.emit(rooms.user(userId), event, data);
  }

  async onModuleDestroy() {
    await this.pub?.quit().catch(() => undefined);
  }
}

@WebSocketGateway({ namespace: '/realtime', cors: { origin: env().CORS_ORIGINS.split(','), credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private sub?: Redis;
  @WebSocketServer() server?: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly authz: AuthzService,
  ) {}

  onModuleInit() {
    if (process.env.WORKER_PROCESS === 'true') return;
    this.sub = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    void this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_channel, raw) => {
      if (!this.server) return;
      try {
        const msg = JSON.parse(raw) as RealtimeMessage;
        this.server.to(msg.room).emit(msg.event, msg.data);
      } catch {
        /* ignore malformed messages */
      }
    });
  }

  async onModuleDestroy() {
    await this.sub?.quit().catch(() => undefined);
  }

  handleConnection(client: Socket) {
    // Clients may emit `subscribe` as soon as they see `connect`, before authentication resolves.
    client.data.ready = this.authenticate(client);
    return client.data.ready;
  }

  private async authenticate(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string | undefined) ?? (client.handshake.headers.authorization as string | undefined)?.replace(/^Bearer /, '');
      if (!token) throw new Error('missing token');
      const principal = await this.jwt.verifyAsync<JwtPrincipal>(token);
      if (principal.typ !== 'user') throw new Error('unsupported principal');
      const authz = await this.authz.getUserAuthz(principal.sub);
      if (!authz || authz.status === 'DISABLED') throw new Error('disabled');
      client.data.authz = authz;
      await client.join([rooms.tenant(authz.tenantId), rooms.user(authz.userId)]);
      if (authz.therapistId) await client.join(rooms.therapist(authz.therapistId));
    } catch (err) {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
      this.logger.debug(`Socket rejected: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { branchId?: string }) {
    await client.data.ready;
    const authz = client.data.authz as { branchIds: string[]; allBranches: boolean } | undefined;
    if (!authz || !body?.branchId) return { ok: false };
    if (!authz.allBranches && !authz.branchIds.includes(body.branchId)) return { ok: false, error: 'forbidden' };
    for (const room of client.rooms) if (room.startsWith('branch:')) await client.leave(room);
    await client.join(rooms.branch(body.branchId));
    return { ok: true };
  }
}

@Global()
@Module({
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
