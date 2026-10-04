import { defineConfig } from 'drizzle-kit';

// Only `generate` is used: it diffs the schema against the last snapshot and writes a SQL
// migration. Migrations are applied by the application itself, never by drizzle-kit (ADR 0003).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
