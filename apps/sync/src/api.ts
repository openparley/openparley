import type { MembersResponse, MeResponse, ThreadResponse, ThreadsResponse } from '@openparley/protocol';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import type { Limits } from './config';
import type { Notifier } from './notify';
import type { Repo, User } from './repo';
import { addCommentSchema, createThreadSchema, pageSchema, updateThreadSchema } from './validation';

type Env = { Variables: { user: User; token: string } };

const isAdmin = (user: User) => user.role === 'owner' || user.role === 'admin';

/** JSON API used by the overlay. Authenticated with bearer tokens from the /connect flow. */
export function apiRoutes(repo: Repo, limits: Limits, notifier: Notifier): Hono<Env> {
  const api = new Hono<Env>();

  api.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token ? repo.userForSession(token, 'api') : null;
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
    c.set('user', user);
    c.set('token', token);
    await next();
  });

  api.get('/me', (c) => {
    const { id, name, email, role } = c.get('user');
    return c.json<MeResponse>({ user: { id, name, email, role } });
  });

  // For @mention suggestions in the composer and highlighting mentions in comments.
  api.get('/members', (c) => c.json<MembersResponse>({ members: repo.listActiveUsers().map(({ id, name, handle }) => ({ id, name, handle })) }));

  api.post('/auth/logout', (c) => {
    repo.deleteSession(c.get('token'));
    return c.body(null, 204);
  });

  api.get('/threads', (c) => {
    const projectId = c.req.query('project') ?? '';
    const page = pageSchema.safeParse(c.req.query('page'));
    if (!page.success) return c.json({ error: 'A valid page path is required.' }, 400);
    if (!repo.findProject(projectId)) return c.json({ error: 'Unknown project.' }, 404);
    return c.json<ThreadsResponse>({ threads: repo.listThreads(projectId, page.data) });
  });

  api.post('/threads', async (c) => {
    const input = await parse(c, createThreadSchema);
    if ('error' in input) return c.json({ error: input.error }, 400);
    if (!repo.findProject(input.data.project)) return c.json({ error: 'Unknown project.' }, 404);
    // E.g. a team that dropped to a one-person plan: everyone keeps their access and their threads,
    // but nobody starts new ones until the workspace fits its plan again.
    const members = limits.members === null ? 0 : repo.listActiveUsers().length;
    if (limits.members !== null && members > limits.members) {
      return c.json(
        { error: `This workspace has ${members} members but its plan allows ${limits.members}. You can still reply to and resolve threads; to start new ones, ask the owner to upgrade or remove members.` },
        403,
      );
    }
    if (limits.threads !== null && repo.threadsCreated() >= limits.threads) {
      return c.json(
        { error: `This workspace has used all ${limits.threads} of its threads. You can still reply to and resolve existing ones; ask the owner to raise the limit.` },
        403,
      );
    }
    const origin = c.req.header('origin');
    const id = repo.createThread({
      projectId: input.data.project,
      page: input.data.page,
      anchor: input.data.anchor,
      authorId: c.get('user').id,
      body: input.data.body,
      environment: input.data.environment ?? (origin && origin !== 'null' ? origin : null),
      revision: input.data.revision ?? null,
    });
    notifier.threadCreated(id, c.get('user'));
    return c.json<ThreadResponse>({ thread: strip(repo.findThread(id)!) }, 201);
  });

  api.get('/threads/:id', (c) => {
    const thread = repo.findThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'This thread no longer exists.' }, 404);
    return c.json<ThreadResponse>({ thread: strip(thread) });
  });

  api.patch('/threads/:id', async (c) => {
    const input = await parse(c, updateThreadSchema);
    if ('error' in input) return c.json({ error: input.error }, 400);
    const id = c.req.param('id');
    if (!repo.findThread(id)) return c.json({ error: 'This thread no longer exists.' }, 404);
    if (repo.setThreadStatus(id, input.data.status)) notifier.statusChanged(id, input.data.status, c.get('user'));
    return c.json<ThreadResponse>({ thread: strip(repo.findThread(id)!) });
  });

  api.delete('/threads/:id', (c) => {
    const thread = repo.findThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'This thread no longer exists.' }, 404);
    const user = c.get('user');
    if (thread.author.id !== user.id && !isAdmin(user)) return c.json({ error: 'Only the author or an admin can delete this thread.' }, 403);
    repo.deleteThread(thread.id);
    return c.body(null, 204);
  });

  api.post('/threads/:id/comments', async (c) => {
    const input = await parse(c, addCommentSchema);
    if ('error' in input) return c.json({ error: input.error }, 400);
    const id = c.req.param('id');
    if (!repo.findThread(id)) return c.json({ error: 'This thread no longer exists.' }, 404);
    notifier.commented(id, repo.addComment(id, c.get('user').id, input.data.body), c.get('user'));
    return c.json<ThreadResponse>({ thread: strip(repo.findThread(id)!) }, 201);
  });

  api.delete('/threads/:id/comments/:commentId', (c) => {
    const { id, commentId } = c.req.param();
    const comment = repo.findComment(id, commentId);
    if (!comment) return c.json({ error: 'This comment no longer exists.' }, 404);
    const user = c.get('user');
    if (comment.authorId !== user.id && !isAdmin(user)) return c.json({ error: 'Only the author or an admin can delete this comment.' }, 403);
    repo.deleteComment(id, commentId);
    return c.body(null, 204);
  });

  return api;
}

function strip<T extends { projectId: string }>(thread: T): Omit<T, 'projectId'> {
  const { projectId: _, ...rest } = thread;
  return rest;
}

async function parse<S extends z.ZodType>(c: Context, schema: S): Promise<{ data: z.infer<S> } | { error: string }> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { error: 'Expected a JSON body.' };
  }
  const result = schema.safeParse(json);
  return result.success ? { data: result.data } : { error: result.error.issues[0]?.message ?? 'Invalid request.' };
}
