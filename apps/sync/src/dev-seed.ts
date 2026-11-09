// Prepares a local database for development: two accounts and a project for the dev site.
// Idempotent, so restarting `bun run dev` keeps whatever you created.
import { loadConfig } from './config';
import { hashPassword } from './crypto';
import { openDatabase } from './db';
import { Repo } from './repo';

export const DEV_PROJECT = 'dev';
export const DEV_PASSWORD = 'openparley-dev';
export const DEV_USERS = [
  { name: 'Olivia Owner', email: 'owner@openparley.test', role: 'owner' },
  { name: 'Max Member', email: 'member@openparley.test', role: 'member' },
] as const;

const siteOrigin = process.env.DEV_SITE_ORIGIN ?? 'http://localhost:3000';
const db = openDatabase(loadConfig().databasePath);
const repo = new Repo(db);

if (!repo.hasUsers()) {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  for (const user of DEV_USERS) repo.createUser({ ...user, passwordHash });
}
const project = repo.findProject(DEV_PROJECT);
if (!project) repo.createProject('Dev site', [siteOrigin], DEV_PROJECT);
else if (!project.origins.includes(siteOrigin)) repo.updateProject(project.id, project.name, [...project.origins, siteOrigin]);
db.close();
