import PDFDocument from 'pdfkit';

export interface InvoicePdfData {
  business: { name: string; legalName?: string | null; address?: string | null; phone?: string | null; email?: string | null; taxId?: string | null; primaryColor?: string | null; footer?: string | null; poweredBy: boolean };
  branch: { name: string; address?: string | null; phone?: string | null };
  invoice: {
    invoiceNumber: string;
    status: string;
    issuedAt: string;
    currency: string;
    subtotal: number;
    discount: number;
    tax: number;
    rounding: number;
    total: number;
    amountPaid: number;
    amountRefunded: number;
    notes?: string | null;
  };
  customer?: { name: string; phone?: string | null; customerCode?: string | null } | null;
  items: { description: string; quantity: number; unitPrice: number; discount: number; taxRate: number; tax: number; total: number; note?: string }[];
  payments: { method: string; amount: number; paidAt: string; reference?: string | null }[];
}

const fmt = (currency: string) => {
  // Standard PDF fonts cannot render the rupee glyph, so amounts use the ISO code prefix.
  const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v: number) => `${currency} ${nf.format(v)}`;
};

/** Renders an A4 tax invoice. Pure function of its input so it can be regenerated at any time. */
export function renderInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${d.invoice.invoiceNumber}`, Author: d.business.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = fmt(d.invoice.currency);
    const accent = d.business.primaryColor && /^#[0-9a-f]{6}$/i.test(d.business.primaryColor) ? d.business.primaryColor : '#0f766e';
    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;

    doc.fillColor(accent).font('Helvetica-Bold').fontSize(20).text(d.business.name, left, 48);
    doc.fillColor('#444').font('Helvetica').fontSize(9);
    if (d.business.legalName && d.business.legalName !== d.business.name) doc.text(d.business.legalName);
    doc.text(d.branch.name);
    if (d.branch.address ?? d.business.address) doc.text((d.branch.address ?? d.business.address)!, { width: 260 });
    const contact = [d.branch.phone ?? d.business.phone, d.business.email].filter(Boolean).join('  ·  ');
    if (contact) doc.text(contact);
    if (d.business.taxId) doc.text(`GSTIN: ${d.business.taxId}`);

    doc.fillColor('#111').font('Helvetica-Bold').fontSize(16).text(d.invoice.status === 'CANCELLED' ? 'INVOICE (VOID)' : 'TAX INVOICE', left, 48, { width, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    doc.text(`Invoice no: ${d.invoice.invoiceNumber}`, { width, align: 'right' });
    doc.text(`Date: ${d.invoice.issuedAt}`, { width, align: 'right' });
    doc.text(`Status: ${d.invoice.status.replace('_', ' ')}`, { width, align: 'right' });

    let y = Math.max(doc.y, 140) + 16;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#ddd').stroke();
    y += 10;
    doc.fillColor('#888').fontSize(8).text('BILL TO', left, y);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(d.customer?.name ?? 'Walk-in customer', left, y + 11);
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    if (d.customer?.customerCode) doc.text(`Customer ID: ${d.customer.customerCode}`);
    if (d.customer?.phone) doc.text(d.customer.phone);
    y = doc.y + 16;

    const cols = [
      { label: 'Item', x: left, w: 190, align: 'left' as const },
      { label: 'Qty', x: left + 190, w: 35, align: 'right' as const },
      { label: 'Rate', x: left + 225, w: 70, align: 'right' as const },
      { label: 'Discount', x: left + 295, w: 65, align: 'right' as const },
      { label: 'Tax', x: left + 360, w: 70, align: 'right' as const },
      { label: 'Amount', x: left + 430, w: width - 430, align: 'right' as const },
    ];
    doc.rect(left, y, width, 20).fill(accent);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    for (const c of cols) doc.text(c.label, c.x + 4, y + 6, { width: c.w - 8, align: c.align });
    y += 24;
    doc.font('Helvetica').fillColor('#111');
    for (const item of d.items) {
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = 48;
      }
      const cells = [item.description, String(item.quantity), money(item.unitPrice), item.discount ? `-${money(item.discount)}` : '-', `${money(item.tax)} (${item.taxRate}%)`, money(item.total)];
      const h = Math.max(doc.heightOfString(item.description, { width: cols[0].w - 8 }), 10);
      cells.forEach((text, i) => doc.fontSize(i === 4 ? 7.5 : 9).text(text, cols[i].x + 4, y, { width: cols[i].w - 8, align: cols[i].align }));
      y += h + 2;
      if (item.note) {
        doc.fontSize(7.5).fillColor('#0f766e').text(item.note, left + 4, y, { width: 300 });
        doc.fillColor('#111');
        y += 10;
      }
      doc.moveTo(left, y + 3).lineTo(right, y + 3).strokeColor('#eee').stroke();
      y += 8;
    }

    y += 6;
    const totals: [string, string, boolean?][] = [
      ['Subtotal', money(d.invoice.subtotal)],
      ...(d.invoice.discount ? ([['Discounts', `-${money(d.invoice.discount)}`]] as [string, string][]) : []),
      ['Tax', money(d.invoice.tax)],
      ...(d.invoice.rounding ? ([['Rounding', money(d.invoice.rounding)]] as [string, string][]) : []),
      ['Total', money(d.invoice.total), true],
      ['Paid', money(d.invoice.amountPaid)],
      ...(d.invoice.amountRefunded ? ([['Refunded', `-${money(d.invoice.amountRefunded)}`]] as [string, string][]) : []),
      ['Balance due', money(Math.max(0, d.invoice.total - d.invoice.amountPaid)), true],
    ];
    for (const [label, value, bold] of totals) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor('#111');
      doc.text(label, right - 230, y, { width: 110, align: 'right' });
      doc.text(value, right - 115, y, { width: 115, align: 'right' });
      y += bold ? 17 : 14;
    }

    if (d.payments.length) {
      y += 8;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#444').text('Payments', left, y);
      y += 13;
      doc.font('Helvetica').fontSize(8.5);
      for (const p of d.payments) {
        doc.text(`${p.paidAt}  ·  ${p.method}${p.reference ? ` (${p.reference})` : ''}  ·  ${money(p.amount)}`, left, y);
        y += 12;
      }
    }
    if (d.invoice.notes) {
      y += 8;
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555').text(d.invoice.notes, left, y, { width });
    }

    const footer = [d.business.footer ?? 'Thank you for visiting us!', d.business.poweredBy ? 'Powered by Rkyves TherapyOS' : null].filter(Boolean).join('   ·   ');
    doc.font('Helvetica').fontSize(8).fillColor('#999').text(footer, left, doc.page.height - 60, { width, align: 'center' });
    doc.end();
  });
}
