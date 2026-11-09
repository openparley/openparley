import { expect, test } from 'bun:test';
import { pageKey, watchNavigation } from '../src/page';

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
