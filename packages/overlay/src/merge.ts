import type { Comment, Thread } from '@openparley/protocol';

/**
 * Combines two copies of the same thread (e.g. local copy + one received via link).
 * Comments are a grow-only set keyed by id; the most recent status change wins.
 * Deterministic and order-independent for comments and status.
 */
export function mergeThread(local: Thread, incoming: Thread): Thread {
  const byId = new Map<string, Comment>();
  for (const c of local.comments) byId.set(c.id, c);
  for (const c of incoming.comments) if (!byId.has(c.id)) byId.set(c.id, c);
  const comments = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const newerStatus = incoming.statusAt > local.statusAt;
  return {
    ...local,
    comments,
    status: newerStatus ? incoming.status : local.status,
    statusAt: newerStatus ? incoming.statusAt : local.statusAt,
  };
}
