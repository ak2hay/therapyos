import { reportCsv } from './report-export';
import { Report } from './report-types';

const report = (rows: Report['tables'][number]['rows']): Report => ({
  key: 'customers',
  title: 'Customers',
  from: '2026-09-01',
  to: '2026-09-30',
  branchId: null,
  metrics: [],
  tables: [{ key: 'list', title: 'Customers', columns: [{ key: 'name', label: 'Name' }, { key: 'spend', label: 'Spend', type: 'money' }], rows }],
});

const lines = (buf: Buffer) => buf.toString('utf8').replace(/^\uFEFF/, '').trim().split('\r\n');

describe('reportCsv', () => {
  it('neutralises spreadsheet formulas in user-controlled cells', () => {
    const out = lines(reportCsv(report([{ name: '=HYPERLINK("http://evil","click")', spend: 10 }, { name: '+91 cmd', spend: 5 }, { name: '@SUM(A1)', spend: 1 }, { name: '-2+3', spend: 2 }])));
    expect(out[1]).toBe(`"'=HYPERLINK(""http://evil"",""click"")",10`);
    expect(out[2]).toBe(`'+91 cmd,5`);
    expect(out[3]).toBe(`'@SUM(A1),1`);
    expect(out[4]).toBe(`'-2+3,2`);
  });

  it('quotes commas, quotes and new lines, and keeps numbers raw', () => {
    const out = lines(reportCsv(report([{ name: 'Kapoor, Aarav "AK"', spend: 12500.5 }])));
    expect(out[0]).toBe('Name,Spend');
    expect(out[1]).toBe('"Kapoor, Aarav ""AK""",12500.5');
  });

  it('starts with a UTF-8 BOM so Excel reads names correctly', () => {
    expect(reportCsv(report([{ name: 'Zoë', spend: 1 }])).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
