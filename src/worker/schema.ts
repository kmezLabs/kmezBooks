// The migrations that ship with this build of the app. Vite bundles the SQL
// files; Vitest resolves the same glob, so tests run the real schema.

import { parseMigrations } from './migrations';

const files = import.meta.glob<string>('/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const MIGRATIONS = parseMigrations(files);
