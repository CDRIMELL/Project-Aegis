import { createDb, type AegisDb } from '../client';
import { migrate } from './migrate';
import { NodeSqliteTransport } from './transport';

export * from './migrate';
export * from './transport';

export interface NodeDatabase {
  readonly db: AegisDb;
  readonly transport: NodeSqliteTransport;
  close(): void;
}

/** Opens (creating if needed) and migrates a database for use from Node. */
export function openNodeDatabase(path: string): NodeDatabase {
  const transport = new NodeSqliteTransport(path);
  try {
    migrate(transport.connection);
  } catch (error) {
    transport.close();
    throw error;
  }
  return {
    db: createDb(transport),
    transport,
    close: () => {
      transport.close();
    },
  };
}
