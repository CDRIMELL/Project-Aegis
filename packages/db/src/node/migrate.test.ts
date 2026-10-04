import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MigrationError } from './migrate';

describe('migrate', () => {
  let folder: string;
  let connection: DatabaseSync;

  function writeMigrations(files: Record<string, string>): void {
    const tags = Object.keys(files);
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }),
    );
    for (const [tag, sql] of Object.entries(files)) {
      writeFileSync(join(folder, `${tag}.sql`), sql);
    }
  }

  const tables = () =>
    connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 't_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'aegis-migrations-'));
    mkdirSync(join(folder, 'meta'));
    connection = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    connection.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('applies pending migrations in order and only once', () => {
    writeMigrations({
      '0000_a': 'CREATE TABLE t_a (x);--> statement-breakpoint\nCREATE TABLE t_b (x);',
    });
    expect(migrate(connection, folder)).toEqual(['0000_a']);
    expect(migrate(connection, folder)).toEqual([]);

    writeMigrations({
      '0000_a': 'CREATE TABLE t_a (x);--> statement-breakpoint\nCREATE TABLE t_b (x);',
      '0001_b': 'CREATE TABLE t_c (x);',
    });
    expect(migrate(connection, folder)).toEqual(['0001_b']);
    expect(tables()).toEqual(['t_a', 't_b', 't_c']);
  });

  it('rolls a failing migration back completely', () => {
    writeMigrations({
      '0000_a': 'CREATE TABLE t_a (x);--> statement-breakpoint\nCREATE TABLE t_a (x);',
    });
    expect(() => migrate(connection, folder)).toThrow(MigrationError);
    expect(tables()).toEqual([]);
    expect(connection.prepare('SELECT count(*) AS n FROM __aegis_migrations').get()).toEqual({
      n: 0,
    });
  });

  it('refuses a migration that changed after it was applied', () => {
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (x);' });
    migrate(connection, folder);
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (x, y);' });
    expect(() => migrate(connection, folder)).toThrow(/changed after it was applied/);
  });

  it('treats CRLF and LF copies of a migration as the same file', () => {
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (\n  x\n);\n' });
    migrate(connection, folder);
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (\r\n  x\r\n);\r\n' });
    expect(migrate(connection, folder)).toEqual([]);
  });

  it('refuses a database created by a newer build', () => {
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (x);', '0001_b': 'CREATE TABLE t_b (x);' });
    migrate(connection, folder);
    writeMigrations({ '0000_a': 'CREATE TABLE t_a (x);' });
    expect(() => migrate(connection, folder)).toThrow(/newer version/);
  });
});
