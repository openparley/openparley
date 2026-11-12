import { expect, test } from 'bun:test';
import { pageHash, pageKey, pageSearch, pathOf, sameVariant, watchNavigation } from '../src/page';

test('normalises equivalent paths to one key', () => {
  expect(pageKey('/')).toBe('/');
  expect(pageKey('/docs/')).toBe('/docs');
  expect(pageKey('/docs/index.html')).toBe('/docs');
  expect(pageKey('/index.html')).toBe('/');
  expect(pageKey('//a//b/')).toBe('/a/b');
});

test('reports pushState navigation and can be unsubscribed', () => {
  let calls = 0;
  const stop = watchNavigation(() => calls++);
  history.pushState(null, '', '/somewhere');
  expect(calls).toBe(1);
  stop();
  history.pushState(null, '', '/else');
  expect(calls).toBe(1);
});

test('keeps the query without tracking parameters, in a stable order', () => {
  expect(pageSearch('')).toBeUndefined();
  expect(pageSearch('?utm_source=mail&gclid=x&UTM_Campaign=y&fbclid=z')).toBeUndefined();
  expect(pageSearch('?tab=specs&id=2&utm_medium=cpc')).toBe('?id=2&tab=specs');
  expect(pageSearch('?id=2&tab=specs')).toBe(pageSearch('?tab=specs&id=2'));
  expect(pageSearch('?ref=partner')).toBe('?ref=partner');
  expect(pageSearch('?q=a b&tag=x&tag=y')).toBe('?q=a+b&tag=x&tag=y');
});

test('keeps route hashes only', () => {
  expect(pageHash('#/settings')).toBe('#/settings');
  expect(pageHash('#!/orders/2')).toBe('#!/orders/2');
  expect(pageHash('#pricing')).toBeUndefined();
  expect(pageHash('')).toBeUndefined();
});

test('compares variants; old threads without a query are the bare path', () => {
  expect(sameVariant({ page: '/p', search: '?id=1' }, { page: '/p', search: '?id=1' })).toBe(true);
  expect(sameVariant({ page: '/p', search: '?id=1' }, { page: '/p', search: '?id=2' })).toBe(false);
  expect(sameVariant({ page: '/p' }, { page: '/p', hash: '#/x' })).toBe(false);
  expect(sameVariant({ page: '/p' }, { page: '/q' })).toBe(false);
  expect(pathOf({ page: '/p', search: '?id=1', hash: '#/x' })).toBe('/p?id=1#/x');
});
