import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../common/context/request-context';
import { Db, DbOrTx, InjectDb } from '../common/prisma/prisma.service';
import { redact } from './audit.service';

export const DomainEvents = {
  TENANT_ONBOARDED: 'tenant.onboarded',
  CUSTOMER_CREATED: 'customer.created',
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_CHECKED_IN: 'appointment.checked_in',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  APPOINTMENT_REMINDER_DUE: 'appointment.reminder_due',
  QUEUE_UPDATED: 'queue.updated',
  SESSION_STARTED: 'session.started',
  SESSION_COMPLETED: 'session.completed',
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_VOIDED: 'invoice.voided',
  PAYMENT_RECEIVED: 'payment.received',
  PAYMENT_REFUNDED: 'payment.refunded',
  PACKAGE_PURCHASED: 'package.purchased',
  PACKAGE_REDEEMED: 'package.redeemed',
  PACKAGE_EXPIRING: 'package.expiring',
  MEMBERSHIP_PURCHASED: 'membership.purchased',
  MEMBERSHIP_EXPIRING: 'membership.expiring',
  CUSTOMER_INACTIVE: 'customer.inactive',
  CUSTOMER_BIRTHDAY: 'customer.birthday',
  FEEDBACK_REQUESTED: 'feedback.requested',
  FEEDBACK_RECEIVED: 'feedback.received',
  STOCK_LOW: 'inventory.stock_low',
  EXPENSE_RECORDED: 'expense.recorded',
} as const;
export type DomainEventType = (typeof DomainEvents)[keyof typeof DomainEvents];

/**
 * Transactional outbox: events are persisted in the same transaction as the business change and
 * relayed to BullMQ by the OutboxRelay, so side effects never fire for rolled-back changes.
 */
@Injectable()
export class EventsService {
  /** In-process signal so the relay can pick new events up immediately instead of waiting for the poll. */
  static readonly signal = new EventEmitter();

  constructor(@InjectDb() private readonly db: Db) {}

  async publish(type: DomainEventType, payload: Record<string, unknown>, tx?: DbOrTx) {
    const client = tx ?? this.db;
    const tenantId = (payload.tenantId as string | undefined) ?? RequestContext.tenantId ?? null;
    await client.domainEvent.create({
      data: {
        tenantId,
        type,
        payload: redact({ ...payload, tenantId, actorId: RequestContext.userId ?? null }) as Prisma.InputJsonValue,
      },
    });
    setImmediate(() => EventsService.signal.emit('published'));
  }
}
