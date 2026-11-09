import { describe, expect, test } from 'bun:test';
import type { Thread } from '@openparley/protocol';
import { isThread } from '../../../packages/overlay/src/share';
import { SITE, anchor, harness } from './harness';

describe('threads API', () => {
  test('full conversation lifecycle', async () => {
    const { owner } = harness();
    const { project, call } = await owner();

    const created = await call('POST', '/threads', { project: project.id, page: '/checkout', anchor, body: 'Padding is off' });
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as { thread: Thread };
    expect(thread.author.name).toBe('Olivia Owner');
    expect(thread.comments.map((c) => c.body)).toEqual(['Padding is off']);

    await call('POST', `/threads/${thread.id}/comments`, { body: 'Fixed in #123' });
    const resolved = await call('PATCH', `/threads/${thread.id}`, { status: 'resolved' });
    expect(((await resolved.json()) as { thread: Thread }).thread.status).toBe('resolved');

    const list = (await (await call('GET', `/threads?project=${project.id}&page=/checkout`)).json()) as { threads: Thread[] };
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0]!.comments.map((c) => c.body)).toEqual(['Padding is off', 'Fixed in #123']);

    const other = (await (await call('GET', `/threads?project=${project.id}&page=/`)).json()) as { threads: Thread[] };
    expect(other.threads).toEqual([]);
  });

  test('responses satisfy the overlay’s own validator (wire contract)', async () => {
    const { owner } = harness();
    const { project, call } = await owner();
    const { thread } = (await (await call('POST', '/threads', { project: project.id, page: '/', anchor, body: 'Hi' })).json()) as { thread: Thread };
    expect(isThread(thread)).toBe(true);
    expect(Object.keys(thread).sort()).toEqual(['anchor', 'author', 'comments', 'createdAt', 'environment', 'id', 'page', 'status', 'statusAt']);
  });

  test('a thread records its environment (the Origin, or the site\'s label) and revision; listing returns all environments', async () => {
    const { owner } = harness();
    const { project, call } = await owner();
    const post = (body: Record<string, unknown>) => call('POST', '/threads', { project: project.id, page: '/', anchor, body: 'x', ...body });

    const byOrigin = ((await (await post({})).json()) as { thread: Thread }).thread;
    expect(byOrigin.environment).toBe(SITE);
    expect(byOrigin.revision).toBeUndefined();

    const labelled = ((await (await post({ environment: 'preview', revision: 'a1b2c3d' })).json()) as { thread: Thread }).thread;
    expect(labelled).toMatchObject({ environment: 'preview', revision: 'a1b2c3d' });
    expect(isThread(labelled)).toBe(true);

    expect((await post({ environment: 'x'.repeat(201) })).status).toBe(400);
    expect((await post({ revision: '' })).status).toBe(400);

    const list = (await (await call('GET', `/threads?project=${project.id}&page=/`)).json()) as { threads: Thread[] };
    expect(list.threads.map((t) => t.environment)).toEqual([SITE, 'preview']);
  });

  test('rejects bad input with a message', async () => {
    const { owner } = harness();
    const { project, call } = await owner();
    const cases = [
      { project: project.id, page: '/', anchor: { ...anchor, point: [2, 0] }, body: 'x' },
      { project: project.id, page: 'no-slash', anchor, body: 'x' },
      { project: project.id, page: '/', anchor, body: '   ' },
      { project: project.id, page: '/', anchor, body: 'x'.repeat(4001) },
    ];
    for (const body of cases) {
      const res = await call('POST', '/threads', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect((await call('POST', '/threads', { project: 'nope', page: '/', anchor, body: 'x' })).status).toBe(404);
  });

  test('requires a valid token', async () => {
    const { owner, api } = harness();
    const { project } = await owner();
    expect((await api(null)('GET', `/threads?project=${project.id}&page=/`)).status).toBe(401);
    expect((await api('forged')('GET', `/threads?project=${project.id}&page=/`)).status).toBe(401);
  });

  test('logout revokes the token', async () => {
    const { owner } = harness();
    const { call } = await owner();
    expect((await call('POST', '/auth/logout')).status).toBe(204);
    expect((await call('GET', '/me')).status).toBe(401);
  });

  test('only authors and admins can delete', async () => {
    const { owner, invited, api } = harness();
    const { b, project, call: ownerCall } = await owner();
    const member = api(await (await invited(b, 'member', 'mo@example.com')).b.connect(project.id));
    const { thread } = (await (await ownerCall('POST', '/threads', { project: project.id, page: '/', anchor, body: 'Owner says' })).json()) as { thread: Thread };
    const reply = (await (await member('POST', `/threads/${thread.id}/comments`, { body: 'Member says' })).json()) as { thread: Thread };
    const ownerComment = reply.thread.comments.find((c) => c.body === 'Owner says')!;
    const memberComment = reply.thread.comments.find((c) => c.body === 'Member says')!;
    expect(reply.thread.comments.map((c) => c.body)).toEqual(['Owner says', 'Member says']);

    expect((await member('DELETE', `/threads/${thread.id}`)).status).toBe(403);
    expect((await member('DELETE', `/threads/${thread.id}/comments/${ownerComment.id}`)).status).toBe(403);
    expect((await member('DELETE', `/threads/${thread.id}/comments/${memberComment.id}`)).status).toBe(204);
    expect((await ownerCall('DELETE', `/threads/${thread.id}`)).status).toBe(204);
    expect((await ownerCall('GET', `/threads/${thread.id}`)).status).toBe(404);
  });

  test('deleting the last comment removes the thread', async () => {
    const { owner } = harness();
    const { project, call } = await owner();
    const { thread } = (await (await call('POST', '/threads', { project: project.id, page: '/', anchor, body: 'Only' })).json()) as { thread: Thread };
    await call('DELETE', `/threads/${thread.id}/comments/${thread.comments[0]!.id}`);
    expect((await call('GET', `/threads/${thread.id}`)).status).toBe(404);
  });

  test('deleting a project removes its threads (foreign keys enforced)', async () => {
    const { owner, repo } = harness();
    const { b, project, call } = await owner();
    const { thread } = (await (await call('POST', '/threads', { project: project.id, page: '/', anchor, body: 'x' })).json()) as { thread: Thread };
    await b.post(`/admin/projects/${project.id}`, { action: 'delete', confirm: 'yes' });
    expect(repo.findThread(thread.id)).toBeNull();
  });
});

describe('CORS', () => {
  test('preflight succeeds only for registered origins', async () => {
    const { owner, app } = harness();
    await owner();
    const preflight = (origin: string) =>
      app.request('http://parley.test/api/threads', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
      });
    const ok = await preflight(SITE);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    const denied = await preflight('https://evil.test');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('wildcard sites get CORS for their subdomains only', async () => {
    const { owner, app, repo } = harness();
    const { project } = await owner();
    repo.updateProject(project.id, 'Shop', [SITE, 'https://*.preview.shop.test']);
    const preflight = (origin: string) =>
      app.request('http://parley.test/api/threads', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    const ok = await preflight('https://pr-1.preview.shop.test');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://pr-1.preview.shop.test');
    expect((await preflight('https://preview.shop.test')).status).toBe(403);
    expect((await preflight('https://pr-1.preview.shop.test.evil.test')).status).toBe(403);
  });

  test('responses to other origins carry no CORS grant', async () => {
    const { owner, api } = harness();
    const { b, project } = await owner();
    const token = await b.connect(project.id);
    const res = await api(token, 'https://evil.test')('GET', '/me');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
