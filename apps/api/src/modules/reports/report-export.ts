import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ColumnType, Report, ReportColumn, ReportTable } from './report-types';

export interface ExportMeta {
  businessName: string;
  branchName: string | null;
  currency: string;
  generatedBy?: string | null;
}

const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function display(value: unknown, type: ColumnType | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'money':
      return `${currency} ${nf2.format(Number(value))}`;
    case 'number':
      return nf0.format(Number(value));
    case 'percent':
      return `${nf0.format(Number(value))}%`;
    case 'date':
      return String(value).slice(0, 10);
    default:
      return String(value);
  }
}

/** Neutralises spreadsheet formula injection (cells beginning with = + - @). */
function safeCell(v: string) {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function csvEscape(v: unknown) {
  const s = safeCell(v === null || v === undefined ? '' : String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of one table (raw values, so the numbers stay numeric for spreadsheets). */
export function reportCsv(report: Report, tableKey?: string): Buffer {
  const tables = tableKey ? report.tables.filter((t) => t.key === tableKey) : report.tables;
  const blocks = tables.map((t) => {
    const lines = [t.columns.map((c) => csvEscape(c.label)).join(',')];
    for (const r of t.rows) lines.push(t.columns.map((c) => csvEscape(r[c.key])).join(','));
    return tables.length > 1 ? [csvEscape(t.title), ...lines].join('\r\n') : lines.join('\r\n');
  });
  // BOM so Excel opens UTF-8 names correctly.
  return Buffer.from(`\uFEFF${blocks.join('\r\n\r\n')}\r\n`, 'utf8');
}

const excelFormat = (type: ColumnType | undefined) => (type === 'money' ? '#,##0.00' : type === 'percent' ? '0.0"%"' : type === 'number' ? '#,##0.##' : undefined);

function sheetName(title: string, used: Set<string>) {
  const base = title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 25)} ${i}`;
  used.add(name);
  return name;
}

export async function reportXlsx(report: Report, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Rkyves TherapyOS';
  wb.created = new Date();
  const used = new Set<string>();

  const summary = wb.addWorksheet(sheetName('Summary', used));
  summary.addRow([report.title]).font = { bold: true, size: 14 };
  summary.addRow([meta.businessName]);
  summary.addRow([`${report.from} to ${report.to}${meta.branchName ? ` · ${meta.branchName}` : ' · All branches'}`]);
  summary.addRow([]);
  for (const m of report.metrics) {
    const row = summary.addRow([m.label, m.value, m.hint ?? '']);
    const fmt = excelFormat(m.type);
    if (fmt) row.getCell(2).numFmt = fmt;
  }
  summary.getColumn(1).width = 32;
  summary.getColumn(2).width = 18;
  summary.getColumn(3).width = 30;

  const addTable = (t: ReportTable) => {
    const ws = wb.addWorksheet(sheetName(t.title, used));
    const header = ws.addRow(t.columns.map((c) => c.label));
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    for (const r of t.rows) ws.addRow(t.columns.map((c) => (typeof r[c.key] === 'string' ? safeCell(r[c.key] as string) : r[c.key])));
    t.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(40, Math.max(c.label.length + 2, ...t.rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length + 2), 10));
      const fmt = excelFormat(c.type);
      if (fmt) col.numFmt = fmt;
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  if (report.series) {
    addTable({ key: 'series', title: report.series.title, columns: [{ key: 'period', label: 'Period', type: 'date' }, ...report.series.lines], rows: report.series.points });
  }
  for (const t of report.tables) if (!(report.series && t.key === 'trend')) addTable(t);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function reportPdf(report: Report, meta: ExportMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `${report.title} ${report.from} to ${report.to}`, Author: meta.businessName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text(report.title, left, 36);
    doc.font('Helvetica').fontSize(10).fillColor('#475569').text(`${meta.businessName} · ${meta.branchName ?? 'All branches'} · ${report.from} to ${report.to}`);
    doc.moveDown(0.8);

    // Metric tiles, four per row.
    const tileW = (width - 30) / 4;
    report.metrics.forEach((m, i) => {
      if (i % 4 === 0 && i > 0) doc.y += 52;
      const x = left + (i % 4) * (tileW + 10);
      const y = doc.y;
      doc.roundedRect(x, y, tileW, 44, 4).fillAndStroke('#f8fafc', '#e2e8f0');
      doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(m.label, x + 8, y + 7, { width: tileW - 16, ellipsis: true, lineBreak: false });
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13).text(display(m.value, m.type, meta.currency), x + 8, y + 20, { width: tileW - 16, lineBreak: false });
      doc.y = y;
    });
    doc.y += 60;

    const drawTable = (t: ReportTable) => {
      const cols: ReportColumn[] = t.columns;
      const numeric = (c: ReportColumn) => c.type === 'money' || c.type === 'number' || c.type === 'percent';
      const weights = cols.map((c) => (numeric(c) ? 1 : c.type === 'date' ? 0.9 : 1.8));
      const total = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / total) * width);
      const header = () => {
        let x = left;
        const y = doc.y;
        doc.rect(left, y - 3, width, 16).fill('#f1f5f9');
        doc.fillColor('#334155').font('Helvetica-Bold').fontSize(8);
        cols.forEach((c, i) => {
          doc.text(c.label, x + 3, y, { width: widths[i] - 6, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
          x += widths[i];
        });
        doc.y = y + 16;
      };
      if (doc.y > bottom() - 60) doc.addPage();
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(t.title, left, doc.y);
      doc.moveDown(0.3);
      header();
      doc.font('Helvetica').fontSize(8);
      if (!t.rows.length) {
        doc.fillColor('#94a3b8').text('No data for this period.', left + 3, doc.y + 2);
        doc.moveDown(1);
      }
      for (const r of t.rows) {
        if (doc.y > bottom()) {
          doc.addPage();
          header();
          doc.font('Helvetica').fontSize(8);
        }
        let x = left;
        const y = doc.y;
        doc.fillColor('#1e293b');
        cols.forEach((c, i) => {
          doc.text(display(r[c.key], c.type, meta.currency), x + 3, y, { width: widths[i] - 6, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
          x += widths[i];
        });
        doc.moveTo(left, y + 12).lineTo(left + width, y + 12).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
        doc.y = y + 14;
      }
      doc.moveDown(1.2);
    };
    for (const t of report.tables) drawTable({ ...t, rows: t.rows.slice(0, 2000) });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(7).text(
        `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''} · Page ${i + 1} of ${range.count} · Rkyves TherapyOS`,
        left,
        doc.page.height - doc.page.margins.bottom - 8,
        { width, align: 'center', lineBreak: false },
      );
    }
    doc.end();
  });
}
