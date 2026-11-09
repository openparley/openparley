import { expect, test } from 'bun:test';
import { mergeThread } from '../src/merge';
import { thread } from './fixtures';

const ada = { id: 'a', name: 'Ada' };
const bo = { id: 'b', name: 'Bo' };

test('unions comments by id in chronological order', () => {
  const local = thread({ comments: [{ id: 'c1', author: ada, body: 'one', createdAt: 1 }, { id: 'c3', author: ada, body: 'three', createdAt: 3 }] });
  const incoming = thread({ comments: [{ id: 'c1', author: ada, body: 'one', createdAt: 1 }, { id: 'c2', author: bo, body: 'two', createdAt: 2 }] });
  expect(mergeThread(local, incoming).comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
});

test('takes the most recent status change', () => {
  const local = thread({ status: 'open', statusAt: 10 });
  const incoming = thread({ status: 'resolved', statusAt: 20 });
  expect(mergeThread(local, incoming).status).toBe('resolved');
  expect(mergeThread(incoming, local).status).toBe('resolved');
});

test('is idempotent', () => {
  const a = thread();
  expect(mergeThread(a, a)).toEqual(a);
});
