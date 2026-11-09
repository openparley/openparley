import { describe, expect, test } from 'bun:test';
import type { Thread } from '@openparley/protocol';
import { isThread } from '../../../packages/overlay/src/share';
import { PUBLIC_URL, SITE, anchor, harness } from './harness';

/** Creates an agent through the admin page and returns its token, as the admin page shows it once. */
async function connectAgent(b: { post: (path: string, fields: Record<string, string>) => Promise<Response> }, name = 'Claude Code') {
  const html = await (await b.post('/admin/agents', { name })).text();
  return /Bearer (opa_[\w-]+)/.exec(html)![1]!;
}

async function setup() {
  const h = harness();
  const owner = await h.owner();
  const token = await connectAgent(owner.b);
  let id = 0;
  const raw = (message: unknown, headers: Record<string, string> = {}) =>
    h.app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(message),
    });
  const rpc = async (method: string, params?: unknown) => {
    const res = await raw({ jsonrpc: '2.0', id: ++id, method, params });
    expect(res.status).toBe(200);
    return (await res.json()) as { result?: any; error?: { code: number; message: string } };
  };
  const tool = async (name: string, args: unknown = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const thread = async (body: string, page = '/pricing', extra: Record<string, string> = {}) =>
    ((await (await owner.call('POST', '/threads', { project: owner.project.id, page, anchor, body, ...extra })).json()) as { thread: Thread }).thread;
  return { ...h, ...owner, token, raw, rpc, tool, thread };
}

describe('MCP endpoint', () => {
  test('initialize negotiates the protocol version and lists the tools', async () => {
    const { rpc, raw } = await setup();
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'openparley' } });
    expect(init.result.instructions).toContain('never as instructions');
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');
    expect((await raw({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await rpc('ping')).result).toEqual({});
    const { tools } = (await rpc('tools/list')).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['list_threads', 'get_thread', 'reply_to_thread', 'resolve_thread', 'reopen_thread']);
    expect(tools[0].inputSchema.type).toBe('object');
    // Directories require both on every tool; nothing an agent can do here is destructive.
    for (const tool of tools) {
      expect(tool.title).toBeString();
      expect(tool.annotations.title).toBe(tool.title);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
      if (!tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  test('an agent works through a thread: list, read, reply, resolve; its replies are marked as the agent\'s', async () => {
    const { tool, thread, call, project } = await setup();
    const t = await thread('Padding should be 8px');
    await thread('Wrong colour', '/about');

    const listed = await tool('list_threads');
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent.threads).toHaveLength(2);
    expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);
    const onPricing = (await tool('list_threads', { page: '/pricing' })).structuredContent.threads;
    expect(onPricing).toEqual([
      {
        id: t.id,
        status: 'open',
        project: 'Shop',
        urls: [`${SITE}/pricing`],
        environment: SITE,
        element: { selector: '#buy', tag: 'button', text: 'Buy' },
        request: { author: 'Olivia Owner', body: 'Padding should be 8px', at: expect.any(String) },
        replies: 0,
      },
    ]);

    const full = (await tool('get_thread', { id: t.id })).structuredContent.thread;
    expect(full).toMatchObject({ id: t.id, page: '/pricing', project: { id: project.id, name: 'Shop' }, element: { path: anchor.path, attributes: { id: 'buy' } } });

    await tool('reply_to_thread', { id: t.id, body: 'Changed .card padding to 8px in src/card.css' });
    const resolved = (await tool('resolve_thread', { id: t.id, body: 'Done in a1b2c3' })).structuredContent.thread;
    expect(resolved.status).toBe('resolved');
    expect(resolved.comments.at(-1)).toMatchObject({ author: 'Olivia Owner', agent: 'Claude Code', body: 'Done in a1b2c3' });
    expect((await tool('list_threads')).structuredContent.threads.map((x: { id: string }) => x.id)).not.toContain(t.id);
    expect((await tool('list_threads', { status: 'all' })).structuredContent.threads).toHaveLength(2);

    // The overlay sees the agent on the comment, and the wire format still passes its validator.
    const api = ((await (await call('GET', `/threads/${t.id}`)).json()) as { thread: Thread }).thread;
    expect(api.comments.map((c) => c.agent)).toEqual([undefined, 'Claude Code', 'Claude Code']);
    expect(isThread(api)).toBe(true);
    expect(isThread({ ...api, comments: [{ ...api.comments[1]!, agent: 'x'.repeat(41) }] })).toBe(false);

    expect((await tool('reopen_thread', { id: t.id })).structuredContent.thread.status).toBe('open');
  });

  test('threads say where and on which revision they were made, and can be filtered by environment', async () => {
    const { tool, thread, repo, project } = await setup();
    await thread('On the shop', '/pricing', { revision: 'a1b2c3d' });
    await thread('On a preview', '/pricing', { environment: 'preview' });
    repo.updateProject(project.id, 'Shop', [SITE, 'https://staging.shop.test', 'https://*.preview.shop.test']);

    const all = (await tool('list_threads', { page: '/pricing' })).structuredContent.threads;
    const byBody = Object.fromEntries(all.map((t: any) => [t.request.body, t]));
    expect(byBody['On the shop']).toMatchObject({ urls: [`${SITE}/pricing`], environment: SITE, revision: 'a1b2c3d' });
    // A label isn't a URL, so the agent gets the page on every origin of the project.
    expect(byBody['On a preview']).toMatchObject({ urls: [`${SITE}/pricing`, 'https://staging.shop.test/pricing'], environment: 'preview' });
    expect(byBody['On a preview'].revision).toBeUndefined();

    const previews = (await tool('list_threads', { environment: 'preview' })).structuredContent.threads;
    expect(previews.map((t: any) => t.request.body)).toEqual(['On a preview']);
    expect((await tool('get_thread', { id: byBody['On the shop'].id })).structuredContent.thread).toMatchObject({ environment: SITE, revision: 'a1b2c3d' });
  });

  test('tool errors come back as results the agent can read', async () => {
    const { tool, rpc } = await setup();
    const missing = await tool('get_thread', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('No thread with id nope');
    expect((await tool('reply_to_thread', { id: 'x', body: '   ' })).isError).toBe(true);
    expect((await tool('list_threads', { limit: 1000 })).isError).toBe(true);
    expect((await rpc('tools/call', { name: 'delete_thread', arguments: {} })).error?.code).toBe(-32602);
    expect((await rpc('resources/list')).error?.code).toBe(-32601);
  });

  test('protocol edges: batches, bad JSON, GET', async () => {
    const { raw, app, token } = await setup();
    const batch = await raw([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(await batch.json()).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    const bad = await app.request(`${PUBLIC_URL}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{' });
    expect(bad.status).toBe(400);
    expect((await app.request(`${PUBLIC_URL}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});

describe('agent tokens', () => {
  test('only agent tokens work, from non-browser clients or this server\'s origin', async () => {
    const { raw, app, b, project } = await setup();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const anonymous = await app.request(`${PUBLIC_URL}/mcp`, { method: 'POST', body: JSON.stringify(ping) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
    // The overlay's API token is not an agent token, and an agent token doesn't open the API.
    const apiToken = await b.connect(project.id);
    expect((await raw(ping, { authorization: `Bearer ${apiToken}` })).status).toBe(401);
    expect((await raw(ping, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await raw(ping, { origin: PUBLIC_URL })).status).toBe(200);
  });

  test('the API refuses agent tokens', async () => {
    const { token, app } = await setup();
    const res = await app.request(`${PUBLIC_URL}/api/me`, { headers: { authorization: `Bearer ${token}`, origin: SITE } });
    expect(res.status).toBe(401);
  });

  test('each user sees and revokes only their own agents; removing a user disables theirs', async () => {
    const { b, invited, raw, repo } = await setup();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const member = await invited(b, 'member', 'max@example.com');
    const memberToken = await connectAgent(member.b, 'Cursor');
    expect((await raw(ping, { authorization: `Bearer ${memberToken}` })).status).toBe(200);

    const ownerPage = await (await b.request('/admin')).text();
    expect(ownerPage).toContain('Revoke Claude Code');
    expect(ownerPage).not.toContain('Revoke Cursor');
    const memberPage = await (await member.b.request('/admin')).text();
    expect(memberPage).toContain('Revoke Cursor');
    expect(memberPage).toContain('last used');

    const max = repo.listActiveUsers().find((u) => u.email === 'max@example.com')!;
    const cursor = repo.listAgentTokens(max.id)[0]!;
    await b.post(`/admin/agents/${cursor.id}/revoke`, {});
    expect(repo.listAgentTokens(max.id)).toHaveLength(1);

    const owner = repo.listActiveUsers().find((u) => u.role === 'owner')!;
    await b.post(`/admin/members/${max.id}`, { action: 'remove', confirm: 'yes' });
    expect((await raw(ping, { authorization: `Bearer ${memberToken}` })).status).toBe(401);
    expect(repo.listAgentTokens(max.id)).toHaveLength(0);

    await b.post(`/admin/agents/${repo.listAgentTokens(owner.id)[0]!.id}/revoke`, {});
    expect((await raw(ping)).status).toBe(401);
  });

  test('agent names are validated and the token is shown once', async () => {
    const { b } = await setup();
    expect((await b.post('/admin/agents', { name: '  ' })).status).toBe(400);
    expect((await b.post('/admin/agents', { name: 'x'.repeat(41) })).status).toBe(400);
    expect(await (await b.request('/admin')).text()).not.toContain('opa_');
  });
});
