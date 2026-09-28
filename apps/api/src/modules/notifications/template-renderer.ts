import Handlebars from 'handlebars';

const hb = Handlebars.create();
const cache = new Map<string, Handlebars.TemplateDelegate>();

export type TemplateVars = Record<string, string | number | null | undefined>;

/** Sample values used for previews and test sends so every documented variable renders. */
export const SAMPLE_VARS: TemplateVars = {
  customer_name: 'Priya',
  branch_name: 'Indiranagar',
  business_name: 'Serenity Wellness',
  service_name: 'Swedish Massage (60 min)',
  therapist_name: 'Arjun',
  appointment_time: 'Mon, 12 Oct, 4:30 PM',
  amount: '₹2,360.00',
  invoice_number: 'INV-IND-000123',
  package_name: '10 Session Relaxation Pack',
  expiry_date: '19 Oct 2026',
  remaining_sessions: 3,
  plan_name: 'Gold',
  days_since_visit: 72,
  product_name: 'Base massage oil',
  quantity: 4,
  reorder_level: 10,
  feedback_link: 'https://app.example.com/f/sample-token',
  offer_code: 'WELCOME10',
  booking_link: 'https://app.example.com/book/serenity-wellness',
};

export const TEMPLATE_VARIABLES = Object.keys(SAMPLE_VARS);

/**
 * Renders a `{{variable}}` template. HTML escaping is only applied to email bodies; SMS and
 * WhatsApp are plain text so entities like `&amp;` must never leak into messages.
 */
export function renderTemplate(source: string, vars: TemplateVars, opts: { html?: boolean } = {}): string {
  const key = `${opts.html ? 'h' : 't'}:${source}`;
  let fn = cache.get(key);
  if (!fn) {
    fn = hb.compile(source, { noEscape: !opts.html, strict: false });
    if (cache.size > 500) cache.clear();
    cache.set(key, fn);
  }
  return fn(vars).trim();
}

/** Validates template syntax, returning a user-readable error or null. */
export function templateError(source: string): string | null {
  try {
    hb.precompile(source);
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0];
  }
}

export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
