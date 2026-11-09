// Who runs OpenParley, filled into the imprint, terms, privacy policy and DPA as {{legal.<key>}}.
// One place to change when details are registered or the business moves to another entity (e.g. a B.V.).
// Null: not published yet; the texts leave it out and the imprint offers it on request.
const DETAILS = {
  /** The legal person or entity that provides the service. */
  operator: null as string | null,
  /** After the name, e.g. "a sole proprietorship (eenmanszaak) registered in the Netherlands". */
  form: 'a sole proprietorship (eenmanszaak) registered in the Netherlands',
  address: null as string | null,
  kvk: null as string | null,
  vat: null as string | null,
  email: 'support@openparley.dev',
  /** Seat of the district court for disputes, e.g. "Amsterdam". */
  court: null as string | null,
  updated: '9 November 2026',
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MISSING_LABELS = { operator: 'name', address: 'address', kvk: 'Chamber of Commerce (KvK) number', vat: 'VAT number' } as const;

export const missingLegalDetails = (details = DETAILS): string[] =>
  (Object.keys(MISSING_LABELS) as Array<keyof typeof MISSING_LABELS>).filter((key) => !details[key]).map((key) => MISSING_LABELS[key]);

/** Every value a page can use, as HTML. */
export function legalFields(details = DETAILS): Record<string, string> {
  const d = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value === null ? null : escapeHtml(value)])) as {
    [K in keyof typeof DETAILS]: string | null;
  };
  const provider = [d.operator ?? 'the maker of OpenParley', d.form, d.kvk && `Chamber of Commerce (KvK) number ${d.kvk}`].filter(Boolean).join(', ');
  const facts = (
    [
      ['Name', d.operator],
      ['Legal form', d.form],
      ['Address', d.address],
      ['Chamber of Commerce (KvK)', d.kvk],
      ['VAT number', d.vat],
    ] as const
  )
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt>\n          <dd>${value}</dd>`)
    .join('\n          ');
  const missing = missingLegalDetails(details);
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
  return {
    email: d.email!,
    updated: d.updated!,
    provider,
    providerWithAddress: d.address ? `${provider}, ${d.address}` : provider,
    imprintFacts: facts,
    imprintMissing: missing.length ? `<p>Our ${list} ${missing.length > 1 ? 'are' : 'is'} available on request by email.</p>` : '',
    court: d.court ? `the competent court in ${d.court}, the Netherlands` : 'the competent court in the Netherlands',
  };
}

export function renderLegal(html: string, fields = legalFields()): string {
  return html.replace(/\{\{legal\.(\w+)\}\}/g, (match, key: string) => {
    if (!(key in fields)) throw new Error(`Unknown legal field in page: ${match}`);
    return fields[key]!;
  });
}
