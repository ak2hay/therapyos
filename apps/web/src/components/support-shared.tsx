'use client';
import { ago, fmtDateTime } from '@/lib/format';

export interface TicketMessage { id: string; authorType: 'USER' | 'ADMIN'; authorName: string | null; body: string; createdAt: string }
export interface Ticket {
  id: string;
  subject: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  lastReplyBy?: string | null;
  messages?: TicketMessage[];
}

export const TICKET_STATUS: Record<Ticket['status'], { label: string; adminLabel: string; tone: 'blue' | 'amber' | 'purple' | 'green' | 'gray' }> = {
  OPEN: { label: 'Open', adminLabel: 'Open', tone: 'blue' },
  IN_PROGRESS: { label: 'In progress', adminLabel: 'In progress', tone: 'amber' },
  WAITING_ON_CUSTOMER: { label: 'Awaiting your reply', adminLabel: 'Waiting on customer', tone: 'purple' },
  RESOLVED: { label: 'Resolved', adminLabel: 'Resolved', tone: 'green' },
  CLOSED: { label: 'Closed', adminLabel: 'Closed', tone: 'gray' },
};
export const PRIORITY_TONE: Record<Ticket['priority'], 'gray' | 'blue' | 'amber' | 'red'> = { LOW: 'gray', MEDIUM: 'blue', HIGH: 'amber', URGENT: 'red' };

export function Conversation({ ticket, mine }: { ticket: Ticket; mine: 'USER' | 'ADMIN' }) {
  return (
    <div className="space-y-3" data-testid="ticket-conversation">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <p className="mb-1 text-xs text-slate-500">Opened {fmtDateTime(ticket.createdAt)}</p>
        <p className="whitespace-pre-wrap text-slate-700">{ticket.description}</p>
      </div>
      {ticket.messages?.map((m) => (
        <div key={m.id} className={`flex ${m.authorType === mine ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.authorType === mine ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white'}`}>
            <p className={`mb-0.5 text-[11px] ${m.authorType === mine ? 'text-brand-100' : 'text-slate-500'}`}>{m.authorName ?? (m.authorType === 'ADMIN' ? 'Support' : 'Customer')} · {ago(m.createdAt)}</p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
