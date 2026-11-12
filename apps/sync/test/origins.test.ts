import { expect, test } from 'bun:test';
import { isOrigin, originMatches, parseOriginEntry, threadUrls } from '../src/origins';

const entry = (line: string) => {
  const parsed = parseOriginEntry(line);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.entry;
};
const error = (line: string) => {
  const parsed = parseOriginEntry(line);
  return 'error' in parsed ? parsed.error : null;
};

test('entries are normalised origins or subdomain wildcards', () => {
  expect(entry('https://Shop.Example.com/')).toBe('https://shop.example.com');
  expect(entry('http://localhost:5173')).toBe('http://localhost:5173');
  expect(entry('https://*.Preview.Example.com')).toBe('https://*.preview.example.com');
  expect(entry('https://*.example.com:8443')).toBe('https://*.example.com:8443');
  expect(entry('https://*.example.com:443')).toBe('https://*.example.com');
});

test('broad, misplaced or malformed wildcards are refused', () => {
  expect(error('https://*')).not.toBeNull();
  expect(error('https://*.com')).toContain('too broad');
  expect(error('http://*.localhost')).toContain('too broad');
  expect(error('https://*.10.0.0')).toContain('too broad');
  expect(error('https://a.*.example.com')).toContain('first part of the host');
  expect(error('https://*.*.example.com')).toContain('first part of the host');
  expect(error('http://localhost:*')).not.toBeNull();
  expect(error('*.example.com')).not.toBeNull();
  expect(error('https://*.example.com/app')).toContain('without a path');
  expect(error('ftp://example.com')).toContain('http:// or https://');
});

test('a wildcard matches any subdomain on the same scheme and port, never the base or a lookalike', () => {
  const preview = 'https://*.preview.example.com';
  expect(originMatches(preview, 'https://pr-12.preview.example.com')).toBe(true);
  expect(originMatches(preview, 'https://a.b.preview.example.com')).toBe(true);
  expect(originMatches(preview, 'https://preview.example.com')).toBe(false);
  expect(originMatches(preview, 'https://evilpreview.example.com')).toBe(false);
  expect(originMatches(preview, 'https://pr-12.preview.example.com.evil.test')).toBe(false);
  expect(originMatches(preview, 'http://pr-12.preview.example.com')).toBe(false);
  expect(originMatches(preview, 'https://pr-12.preview.example.com:8443')).toBe(false);
  expect(originMatches('https://*.example.com:8443', 'https://a.example.com:8443')).toBe(true);
  expect(originMatches('https://shop.example.com', 'https://shop.example.com')).toBe(true);
  expect(originMatches('https://shop.example.com', 'https://a.shop.example.com')).toBe(false);
  expect(originMatches(preview, 'null')).toBe(false);
});

test('isOrigin only accepts what a browser sends as Origin', () => {
  expect(isOrigin('https://shop.example.com')).toBe(true);
  expect(isOrigin('http://localhost:5173')).toBe(true);
  for (const bad of ['', 'null', 'https://shop.example.com/', 'https://shop.example.com:443', 'javascript:alert(1)', 'https://*.example.com']) {
    expect(isOrigin(bad)).toBe(false);
  }
});

test('thread URLs include the query and route hash the thread was made on', () => {
  const thread = { page: '/product', search: '?id=2', hash: '#/specs' };
  expect(threadUrls({ ...thread, environment: 'https://shop.test' }, [])).toEqual(['https://shop.test/product?id=2#/specs']);
  expect(threadUrls({ ...thread, environment: 'preview' }, ['https://a.test', 'https://*.b.test'])).toEqual(['https://a.test/product?id=2#/specs']);
  expect(threadUrls({ page: '/' }, ['https://a.test'])).toEqual(['https://a.test/']);
});
