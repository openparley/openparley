// Who runs OpenParley, filled into the imprint, terms, privacy policy and DPA as {{legal.<key>}}.
// One place to change when the business moves to another legal entity (e.g. a B.V.).
export const LEGAL = {
  /** The legal person or entity that provides the service. */
  operator: 'TODO legal name',
  /** Sentence fragment after the name, e.g. "a sole proprietorship (eenmanszaak) registered in the Netherlands". */
  form: 'a sole proprietorship (eenmanszaak) registered in the Netherlands',
  address: 'TODO street and number, postcode, city, the Netherlands',
  kvk: 'TODO',
  vat: 'TODO',
  email: 'support@openparley.dev',
  /** Seat of the district court for disputes, e.g. "Amsterdam". */
  court: 'TODO',
  updated: '9 November 2026',
} as const;

export const unfilledLegalFields = (): string[] =>
  Object.entries(LEGAL)
    .filter(([, value]) => value.startsWith('TODO'))
    .map(([key]) => key);

export const renderLegal = (html: string): string =>
  html.replace(/\{\{legal\.(\w+)\}\}/g, (match, key: string) => {
    if (!(key in LEGAL)) throw new Error(`Unknown legal field in page: ${match}`);
    return LEGAL[key as keyof typeof LEGAL];
  });
