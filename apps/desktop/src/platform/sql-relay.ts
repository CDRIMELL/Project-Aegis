import type { SqlResult, SqlStatement, SqlTransport } from '@aegis/db';

/*
 * SQL relay between a Web Worker and the native core.
 *
 * Tauri's IPC is not available inside a worker (ADR 0002), so a worker's SQL travels to the UI
 * thread as `sql:request` and comes back as `sql:result`. The UI thread forwards the statements
 * unchanged; it never inspects or alters them. Both the simulation worker and the reference-data
 * worker use this.
 */

export type SqlRequest =
  | { readonly op: 'query'; readonly statement: SqlStatement }
  | { readonly op: 'batch'; readonly statements: readonly SqlStatement[] };

export interface SqlRequestMessage {
  readonly kind: 'sql:request';
  readonly id: number;
  readonly request: SqlRequest;
}

export interface SqlResultMessage {
  readonly kind: 'sql:result';
  readonly id: number;
  readonly outcome:
    | { readonly ok: true; readonly value: SqlResult | SqlResult[] }
    | { readonly ok: false; readonly error: string };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Worker side: a transport whose statements are executed by the UI thread. */
export function createRelayTransport(post: (message: SqlRequestMessage) => void): {
  transport: SqlTransport;
  /** Feed every `sql:result` message received from the UI thread into this. */
  receive(message: SqlResultMessage): void;
} {
  const pending = new Map<
    number,
    { resolve(value: SqlResult | SqlResult[]): void; reject(error: Error): void }
  >();
  let nextId = 1;

  const send = <T extends SqlResult | SqlResult[]>(request: SqlRequest): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: SqlResult | SqlResult[]) => void, reject });
      post({ kind: 'sql:request', id, request });
    });

  return {
    transport: {
      query: (statement) => send<SqlResult>({ op: 'query', statement }),
      batch: (statements) => send<SqlResult[]>({ op: 'batch', statements }),
    },
    receive(message) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.outcome.ok) {
        entry?.resolve(message.outcome.value);
      } else {
        entry?.reject(new Error(message.outcome.error));
      }
    },
  };
}

/** UI-thread side: executes one relayed request and posts the outcome back to the worker. */
export async function serveSqlRequest(
  worker: Worker,
  message: SqlRequestMessage,
  transport: SqlTransport,
): Promise<void> {
  let outcome: SqlResultMessage['outcome'];
  try {
    const value =
      message.request.op === 'query'
        ? await transport.query(message.request.statement)
        : await transport.batch(message.request.statements);
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error: describe(error) };
  }
  const reply: SqlResultMessage = { kind: 'sql:result', id: message.id, outcome };
  worker.postMessage(reply);
}
