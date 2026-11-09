import { ANCHOR_VERSION, LIMITS } from '@openparley/protocol';
import { z } from 'zod';
import { parseOriginEntry } from './origins';

const body = z.string().trim().min(1, 'Write something first.').max(LIMITS.commentBody);

export const anchorSchema = z.object({
  v: z.literal(ANCHOR_VERSION),
  selector: z.string().max(LIMITS.anchorSelector),
  path: z.string().max(LIMITS.anchorPath),
  tag: z.string().min(1).max(64),
  text: z.string().max(LIMITS.anchorText),
  attrs: z
    .record(z.string().max(64), z.string().max(LIMITS.anchorAttrValue))
    .refine((attrs) => Object.keys(attrs).length <= 20, 'Too many attributes'),
  point: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
});

export const pageSchema = z.string().startsWith('/').max(2048);

export const createThreadSchema = z.object({
  project: z.string().min(1).max(64),
  page: pageSchema,
  anchor: anchorSchema,
  body,
  environment: z.string().trim().min(1).max(LIMITS.environment).optional(),
  revision: z.string().trim().min(1).max(LIMITS.revision).optional(),
});

export const addCommentSchema = z.object({ body });

export const updateThreadSchema = z.object({ status: z.enum(['open', 'resolved']) });

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const nameSchema = z.string().trim().min(1, 'Enter your name.').max(LIMITS.authorName);
export const passwordSchema = z.string().min(10, 'Use at least 10 characters for your password.').max(200);

/** Parses one allowed site per line: an origin (https://staging.example.com) or a wildcard (https://*.example.com). */
export function parseOrigins(text: string): { origins: string[] } | { error: string } {
  const origins = new Set<string>();
  for (const line of text.split(/[\s,]+/)) {
    if (!line) continue;
    const parsed = parseOriginEntry(line);
    if ('error' in parsed) return parsed;
    origins.add(parsed.entry);
  }
  return { origins: [...origins] };
}

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1, 'Enter a mention name.')
      .max(30, 'Keep your mention name under 30 characters.')
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_])?$/, 'Use letters, numbers, dots, dashes and underscores, without spaces.'),
  );

export const agentNameSchema = z.string().trim().min(1, 'Give the agent a name.').max(LIMITS.agentName, `Keep the agent's name under ${LIMITS.agentName} characters.`);
