import { afterEach, beforeEach, expect, test } from 'bun:test';
import { memberKey, readFlag } from '../src/gate';
import { SyncStore } from '../src/store/sync';
import { thread } from './fixtures';

const SERVER = 'https://parley.example.com';
const TOKEN_KEY = `openparley:v1:token:${SERVER}`;
const realFetch = globalThis.fetch;
let meStatus = 200;
let pageThreads: unknown[] = [];
let posted: Record<string, unknown>[] = [];
let listed: URL[] = [];
let stores: SyncStore[] = [];

beforeEach(() => {
  localStorage.clear();
  meStatus = 200;
  pageThreads = [];
  posted = [];
  listed = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/threads') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return Response.json({ thread: thread({ id: 'new', page: '/', environment: body.environment ?? 'https://example.test' }) }, { status: 201 });
    }
    if (url.endsWith('/api/me')) {
      return meStatus === 200
        ? Response.json({ user: { id: 'u1', name: 'Olivia', email: 'o@example.com', role: 'owner' } })
        : Response.json({ error: 'Sign in to continue.' }, { status: meStatus });
    }
    if (url.includes('/api/threads?')) {
      listed.push(new URL(url));
      return Response.json({ threads: pageThreads });
    }
    if (url.endsWith('/api/auth/logout')) return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const store of stores) store.destroy();
  stores = [];
  globalThis.fetch = realFetch;
});

async function ready(extra: { environment?: string; revision?: string } = {}): Promise<SyncStore> {
  const store = new SyncStore({ server: SERVER, project: 'p1', page: '/', ...extra });
  stores.push(store);
  for (let i = 0; i < 50 && store.getState().status === 'loading'; i++) await Bun.sleep(5);
  return store;
}

test('a confirmed sign-in marks this browser as a team member', async () => {
  localStorage.setItem(TOKEN_KEY, 'token');
  const store = await ready();
  expect(store.getState().status).toBe('ready');
  expect(readFlag(memberKey(SERVER))).toBe(true);
});

test('an expired token keeps membership, so teammates still get a Sign in button', async () => {
  localStorage.setItem(TOKEN_KEY, 'expired');
  localStorage.setItem(memberKey(SERVER), '1');
  meStatus = 401;
  const store = await ready();
  expect(store.getState().status).toBe('signed-out');
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(readFlag(memberKey(SERVER))).toBe(true);
});

test('signing out ends membership', async () => {
  localStorage.setItem(TOKEN_KEY, 'token');
  const store = await ready();
  await store.signOut();
  expect(readFlag(memberKey(SERVER))).toBe(false);
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
});

test('no token means no membership', async () => {
  const store = await ready();
  expect(store.getState().status).toBe('signed-out');
  expect(readFlag(memberKey(SERVER))).toBe(false);
});

test('threads from other environments are kept apart; old threads without one show everywhere', async () => {
  localStorage.setItem(TOKEN_KEY, 'token');
  pageThreads = [
    thread({ id: 'here', page: '/', environment: 'https://example.test' }),
    thread({ id: 'old', page: '/' }),
    thread({ id: 'prod', page: '/', environment: 'https://www.example.com' }),
  ];
  const store = await ready();
  expect(store.getState().threads.map((t) => t.id)).toEqual(['here', 'old']);
  expect(store.getState().elsewhere.map((t) => t.id)).toEqual(['prod']);

  // Without data-environment the server takes the Origin; the store sends nothing.
  await store.createThread({ page: '/' }, thread().anchor, 'Hi');
  expect(posted[0]).not.toHaveProperty('environment');
  expect(store.getState().threads.map((t) => t.id)).toContain('new');
});

test('data-environment groups origins and is sent with the revision', async () => {
  localStorage.setItem(TOKEN_KEY, 'token');
  pageThreads = [thread({ id: 'preview', page: '/', environment: 'preview' }), thread({ id: 'origin', page: '/', environment: 'https://example.test' })];
  const store = await ready({ environment: 'preview', revision: 'a1b2c3d' });
  expect(store.getState().threads.map((t) => t.id)).toEqual(['preview']);
  expect(store.getState().elsewhere.map((t) => t.id)).toEqual(['origin']);
  await store.createThread({ page: '/' }, thread().anchor, 'Hi');
  expect(posted[0]).toMatchObject({ environment: 'preview', revision: 'a1b2c3d' });
  expect(store.getState().threads.map((t) => t.id)).toContain('new');
});

test('lists the whole environment, plus this page from other environments; new threads keep their query', async () => {
  localStorage.setItem(TOKEN_KEY, 'token');
  pageThreads = [
    thread({ id: 'home', page: '/', environment: 'https://example.test' }),
    thread({ id: 'pricing', page: '/pricing', environment: 'https://example.test' }),
    thread({ id: 'prod-home', page: '/', environment: 'https://www.example.com' }),
    thread({ id: 'prod-pricing', page: '/pricing', environment: 'https://www.example.com' }),
  ];
  const store = await ready();
  expect(Object.fromEntries(listed[0]!.searchParams)).toEqual({ project: 'p1', environment: 'https://example.test', page: '/' });
  expect(store.getState().threads.map((t) => t.id)).toEqual(['home', 'pricing']);
  expect(store.getState().elsewhere.map((t) => t.id)).toEqual(['prod-home']);

  // Moving to another page keeps the environment's threads and only swaps the other environments'.
  store.setPage('/pricing');
  expect(store.getState().threads.map((t) => t.id)).toEqual(['home', 'pricing']);
  expect(store.getState().elsewhere.map((t) => t.id)).toEqual(['prod-pricing']);

  await store.createThread({ page: '/pricing', search: '?plan=team' }, thread().anchor, 'Hi');
  expect(posted[0]).toMatchObject({ page: '/pricing', search: '?plan=team' });
});
