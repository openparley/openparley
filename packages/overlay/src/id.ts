// crypto.randomUUID is unavailable on plain-http origins; getRandomValues works everywhere.
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
