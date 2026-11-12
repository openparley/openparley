import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { openInstance } from '../src/instance';
import type { Thread } from '@openparley/protocol';
import { openDatabase } from '../src/db';
import { SITE, anchor, harness } from './harness';

test('limits are optional and validated', () => {
  expect(loadConfig({}).limits).toEqual({ members: null, projects: null, threads: null });
  expect(loadConfig({ MAX_MEMBERS: '10', MAX_PROJECTS: '2', MAX_THREADS: '100' }).limits).toEqual({ members: 10, projects: 2, threads: 100 });
  expect(() => loadConfig({ MAX_THREADS: '-1' })).toThrow('MAX_THREADS');
  expect(() => loadConfig({ MAX_MEMBERS: '0' })).toThrow('MAX_MEMBERS');
  expect(() => loadConfig({ MAX_PROJECTS: 'lots' })).toThrow('MAX_PROJECTS');
});

test('project limit', async () => {
  const { owner, repo } = harness({ env: { MAX_PROJECTS: '1' } });
  const { b } = await owner();
  const res = await b.post('/admin/projects', { name: 'Second', origins: SITE });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('up to 1 projects');
  expect(repo.listProjects()).toHaveLength(1);
});

test('member limit counts pending invites, and is checked again on acceptance', async () => {
  const { owner, invited, repo } = harness({ env: { MAX_MEMBERS: '3' } });
  const { b } = await owner();
  await invited(b, 'member', 'one@example.com');
  const pending = await (await b.post('/admin/invites', { role: 'member' })).text();
  expect(pending).toContain('3 of 3 seats used');
  const blocked = await b.post('/admin/invites', { role: 'member' });
  expect(blocked.status).toBe(400);
  expect(await blocked.text()).toContain('counting pending invites');
  expect(repo.listActiveUsers()).toHaveLength(2);
});

test('over the member limit (e.g. after a downgrade) nobody starts threads, but replies still work', async () => {
  const { owner, repo } = harness({ env: { MAX_MEMBERS: '1' } });
  const { project, call } = await owner();
  const create = () => call('POST', '/threads', { project: project.id, page: '/', anchor, body: 'x' });
  const res = await create();
  expect(res.status).toBe(201);
  const { thread } = (await res.json()) as { thread: Thread };
  // Members who were there before the plan shrank keep their accounts.
  repo.createUser({ email: 'max@example.com', name: 'Max', passwordHash: 'x', role: 'member' });
  const blocked = await create();
  expect(blocked.status).toBe(403);
  expect(((await blocked.json()) as { error: string }).error).toContain('has 2 members but its plan allows 1');
  expect((await call('POST', `/threads/${thread.id}/comments`, { body: 'still fine' })).status).toBe(201);
  expect((await call('PATCH', `/threads/${thread.id}`, { status: 'resolved' })).status).toBe(200);
});

test('no limits means no seat counter', async () => {
  const { owner } = harness();
  const { b } = await owner();
  const html = await (await b.request('/admin')).text();
  expect(html).not.toContain('seats used');
  expect(html).not.toContain('threads used');
});

test('thread limit counts threads ever created and never blocks replies', async () => {
  const { owner } = harness({ env: { MAX_THREADS: '2' } });
  const { b, project, call } = await owner();
  const create = (body: string) => call('POST', '/threads', { project: project.id, page: '/', anchor, body });
  const { thread } = (await (await create('one')).json()) as { thread: Thread };
  expect((await create('two')).status).toBe(201);

  const blocked = await create('three');
  expect(blocked.status).toBe(403);
  expect(((await blocked.json()) as { error: string }).error).toContain('all 2 of its threads');

  expect((await call('POST', `/threads/${thread.id}/comments`, { body: 'still fine' })).status).toBe(201);
  expect((await call('PATCH', `/threads/${thread.id}`, { status: 'resolved' })).status).toBe(200);

  expect((await call('DELETE', `/threads/${thread.id}`)).status).toBe(204);
  expect((await create('after delete')).status).toBe(403);
  expect(await (await b.request('/admin')).text()).toContain('2 of 2 threads used');
});

test('LIMITS_URL is linked next to the thread counter', async () => {
  expect(loadConfig({}).limitsUrl).toBeNull();
  expect(() => loadConfig({ LIMITS_URL: 'not a url' })).toThrow();
  const { owner } = harness({ env: { MAX_THREADS: '5', LIMITS_URL: 'https://host.example/plans' } });
  const { b } = await owner();
  expect(await (await b.request('/admin')).text()).toContain('<a href="https://host.example/plans">Plans</a>');
});

test('the thread counter starts at the existing number of threads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openparley-counter-'));
  const path = join(dir, 'old.db');
  const db = openDatabase(path);
  db.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u', 'a@b.c', 'A', 'x', 'owner', 0);
    INSERT INTO projects VALUES ('p', 'P', '[]', 0);
    INSERT INTO threads (id, project_id, page, anchor, status, status_at, author_id, created_at) VALUES ('t1', 'p', '/', '{}', 'open', 0, 'u', 0), ('t2', 'p', '/', '{}', 'open', 0, 'u', 0);
    DROP INDEX threads_environment; ALTER TABLE threads DROP COLUMN search; ALTER TABLE threads DROP COLUMN hash;
    DROP INDEX users_handle; ALTER TABLE users DROP COLUMN handle;
    DROP TABLE notifications; DROP TABLE notification_channels; DROP TABLE notification_project_levels; DROP TABLE notification_settings;
    DROP TABLE counters; DROP TABLE oauth_codes; DROP TABLE agent_tokens; DROP TABLE oauth_clients; ALTER TABLE comments DROP COLUMN agent; ALTER TABLE threads DROP COLUMN environment; ALTER TABLE threads DROP COLUMN revision; ALTER TABLE invites DROP COLUMN email; PRAGMA user_version = 1;`);
  db.close();
  const reopened = openDatabase(path);
  expect(reopened.query<{ value: number }, []>("SELECT value FROM counters WHERE name = 'threads_created'").get()!.value).toBe(2);
  reopened.close();
});

test('openInstance migrates its database and close() releases it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openparley-instance-'));
  const config = { ...loadConfig({ PUBLIC_URL: 'http://a.test', DATABASE_PATH: join(dir, 'a.db') }), overlayDir: '/nonexistent' };
  const first = openInstance({ config, setupToken: 't' });
  expect((await first.app.request('http://a.test/health')).status).toBe(200);
  expect(first.repo.hasUsers()).toBe(false);
  first.close();
  expect(() => first.repo.hasUsers()).toThrow();
  const again = openInstance({ config, setupToken: 't' });
  expect(again.repo.hasUsers()).toBe(false);
  again.close();
});
