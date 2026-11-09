import { beforeEach, expect, test } from 'bun:test';
import { LocalStore } from '../src/store/local';
import { thread } from './fixtures';

const anchor = thread().anchor;

beforeEach(() => localStorage.clear());

test('requires a name before posting, then remembers it', async () => {
  const store = new LocalStore('/');
  expect(store.createThread('/', anchor, 'hi')).rejects.toThrow('name');
  store.setName('  Ada  ');
  await store.createThread('/', anchor, 'hi');
  expect(new LocalStore('/').getState().user?.name).toBe('Ada');
});

test('scopes threads to the current page', async () => {
  const store = new LocalStore('/');
  store.setName('Ada');
  await store.createThread('/', anchor, 'home');
  await store.createThread('/about', anchor, 'about');
  expect(store.getState().threads.map((t) => t.comments[0]!.body)).toEqual(['home']);
  store.setPage('/about');
  expect(store.getState().threads.map((t) => t.comments[0]!.body)).toEqual(['about']);
});

test('does not overwrite changes written by another tab', async () => {
  const tabA = new LocalStore('/');
  tabA.setName('Ada');
  const tabB = new LocalStore('/');
  const created = await tabA.createThread('/', anchor, 'from A');
  await tabB.addComment(created.id, 'reply from B');
  await tabA.setStatus(created.id, 'resolved');
  const stored = new LocalStore('/').getState().threads[0]!;
  expect(stored.comments.map((c) => c.body)).toEqual(['from A', 'reply from B']);
  expect(stored.status).toBe('resolved');
});

test('importing a shared thread merges with an existing copy', async () => {
  const store = new LocalStore('/');
  store.setName('Ada');
  const mine = await store.createThread('/', anchor, 'original');
  const theirs = { ...mine, comments: [...mine.comments, { id: 'x', author: { id: 'b', name: 'Bo' }, body: 'their reply', createdAt: Date.now() + 1 }] };
  store.importThreads([theirs]);
  expect(store.getState().threads[0]!.comments.map((c) => c.body)).toEqual(['original', 'their reply']);
});

test('ignores corrupt storage instead of crashing', () => {
  localStorage.setItem('openparley:v1:threads', '{"bad": {"id": 3}, "worse": null}');
  expect(new LocalStore('/').getState().threads).toEqual([]);
  localStorage.setItem('openparley:v1:threads', 'not json');
  expect(new LocalStore('/').getState().threads).toEqual([]);
});

test('deleting the last comment deletes the thread', async () => {
  const store = new LocalStore('/');
  store.setName('Ada');
  const t = await store.createThread('/', anchor, 'only');
  await store.deleteComment(t.id, t.comments[0]!.id);
  expect(store.getState().threads).toEqual([]);
});
