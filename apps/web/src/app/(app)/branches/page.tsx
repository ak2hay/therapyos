'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download, Pencil, Plus, QrCode } from 'lucide-react';
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  StatusBadge,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Select,
} from '@therapyos/ui';
import { branchSchema } from '@therapyos/validation';
import { api, errorMessage } from '@/lib/api';
import { refreshSession } from '@/lib/auth-store';
import { useZodForm } from '@/lib/forms';

interface Branch {
  id: string;
  name: string;
  code: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  openingTime: string;
  closingTime: string;
  status: string;
  publicBookingEnabled: boolean;
}

function BranchForm({ branch, onDone }: { branch?: Branch; onDone: () => void }) {
  const qc = useQueryClient();
  const form = useZodForm(branchSchema, {
    name: branch?.name ?? '',
    code: branch?.code ?? '',
    phone: branch?.phone ?? '',
    email: branch?.email ?? '',
    address: branch?.address ?? '',
    city: branch?.city ?? '',
    state: branch?.state ?? '',
    pincode: branch?.pincode ?? '',
    openingTime: branch?.openingTime ?? '09:00',
    closingTime: branch?.closingTime ?? '21:00',
    status: (branch?.status as 'ACTIVE' | 'INACTIVE') ?? 'ACTIVE',
    publicBookingEnabled: branch?.publicBookingEnabled ?? true,
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async (values) => {
    try {
      if (branch) await api.patch(`/branches/${branch.id}`, values);
      else await api.post('/branches', values);
      toast.success(branch ? 'Branch updated' : 'Branch created');
      await qc.invalidateQueries({ queryKey: ['branches'] });
      await refreshSession();
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });
  const err = (k: string) => (errors as Record<string, { message?: string }>)[k]?.message;
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" error={err('name')}><Input {...form.register('name')} /></Field>
      <Field label="Code" error={err('code')} hint="Used in invoice numbers"><Input {...form.register('code')} /></Field>
      <Field label="Phone" error={err('phone')}><Input {...form.register('phone')} /></Field>
      <Field label="Email" error={err('email')}><Input {...form.register('email')} /></Field>
      <Field label="Address" className="sm:col-span-2" error={err('address')}><Input {...form.register('address')} /></Field>
      <Field label="City"><Input {...form.register('city')} /></Field>
      <Field label="State"><Input {...form.register('state')} /></Field>
      <Field label="Pincode"><Input {...form.register('pincode')} /></Field>
      <Field label="Status">
        <Select {...form.register('status')}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </Select>
      </Field>
      <Field label="Opens at" error={err('openingTime')}><Input type="time" {...form.register('openingTime')} /></Field>
      <Field label="Closes at" error={err('closingTime')}><Input type="time" {...form.register('closingTime')} /></Field>
      <Checkbox className="sm:col-span-2" label="Allow public online booking for this branch" {...form.register('publicBookingEnabled')} />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>Save</Button>
      </div>
    </form>
  );
}

function BookingQr({ branchId }: { branchId: string }) {
  const { data } = useQuery({ queryKey: ['booking-qr', branchId], queryFn: () => api.get<{ url: string; png: string; enabled: boolean; branchName: string }>(`/booking/qr/${branchId}`) });
  if (!data) return <LoadingBlock />;
  return (
    <div className="flex flex-col items-center gap-3 py-2">
      {!data.enabled && <p className="w-full rounded-lg bg-amber-50 p-2 text-center text-xs text-amber-800">Online booking is switched off for this branch. Edit the branch to allow it.</p>}
      { }
      <img src={data.png} alt={`Booking QR code for ${data.branchName}`} className="h-56 w-56" data-testid="booking-qr" />
      <a href={data.url} target="_blank" rel="noreferrer" className="break-all text-center text-xs text-brand-700 hover:underline">{data.url}</a>
      <div className="flex gap-2">
        <a href={data.png} download={`booking-qr-${data.branchName.replace(/\s+/g, '-').toLowerCase()}.png`}><Button variant="outline" size="sm"><Download className="h-4 w-4" /> Download</Button></a>
        <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(data.url); toast.success('Link copied'); }}><Copy className="h-4 w-4" /> Copy link</Button>
      </div>
    </div>
  );
}

export default function BranchesPage() {
  const [editing, setEditing] = useState<Branch | null | undefined>(undefined);
  const [qr, setQr] = useState<Branch | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  return (
    <div>
      <PageHeader
        title="Branches"
        description="Locations of your business. Each branch has its own queue, prices, stock and reports."
        actions={<Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" /> Add branch</Button>}
      />
      <Card>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.length ? (
          <EmptyState title="No branches yet" action={<Button onClick={() => setEditing(null)}>Add your first branch</Button>} />
        ) : (
          <Table>
            <THead>
              <TR><TH>Branch</TH><TH>Code</TH><TH>Contact</TH><TH>Hours</TH><TH>Status</TH><TH /></TR>
            </THead>
            <TBody>
              {data.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <p className="font-medium text-slate-900">{b.name}</p>
                    <p className="text-xs text-slate-500">{[b.address, b.city].filter(Boolean).join(', ')}</p>
                  </TD>
                  <TD className="font-mono text-xs">{b.code}</TD>
                  <TD className="text-xs">{b.phone}<br />{b.email}</TD>
                  <TD className="text-xs">{b.openingTime} - {b.closingTime}</TD>
                  <TD><StatusBadge status={b.status} /></TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setQr(b)} title="Branch QR"><QrCode className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)}><Pencil className="h-4 w-4" /></Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? 'Edit branch' : 'New branch'} size="lg">
        <BranchForm branch={editing ?? undefined} onDone={() => setEditing(undefined)} />
      </Modal>
      <Modal open={!!qr} onClose={() => setQr(null)} title={`${qr?.name}: online booking`} description="Customers scan this to book at this branch. Print it for the front desk, windows or flyers." size="sm">
        {qr && <BookingQr branchId={qr.id} />}
      </Modal>
    </div>
  );
}
