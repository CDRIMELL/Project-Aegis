/// Simulation worker entry point. Runs the engine off the UI thread (ADR 0002).
import { createDb, SqliteWorldStore, type SqlResult, type SqlTransport } from '@aegis/db';
import { simInstant } from '@aegis/domain';
import { SimulationRunner, type HostClock } from '@aegis/sim';
import type { FromWorker, SqlRequest, ToWorker } from './protocol';

/** How often real elapsed time is converted into simulation steps. */
const ADVANCE_INTERVAL_MS = 100;

function post(message: FromWorker): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- SQL relay: requests go to the UI thread, which forwards them to the native core. ---

interface PendingSql {
  resolve(value: SqlResult | SqlResult[]): void;
  reject(error: Error): void;
}

const pendingSql = new Map<number, PendingSql>();
let nextSqlId = 1;

function sql<T extends SqlResult | SqlResult[]>(request: SqlRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextSqlId++;
    pendingSql.set(id, { resolve: resolve as PendingSql['resolve'], reject });
    post({ kind: 'sql:request', id, request });
  });
}

const transport: SqlTransport = {
  query: (statement) => sql<SqlResult>({ op: 'query', statement }),
  batch: (statements) => sql<SqlResult[]>({ op: 'batch', statements }),
};

// --- Simulation lifecycle ---

const host: HostClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
};

let runner: SimulationRunner | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function fail(error: unknown): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  runner = null;
  post({ kind: 'failed', message: describe(error) });
}

async function start(newWorld: { seed: string; epochMs: number }): Promise<void> {
  const opened = await SimulationRunner.open({
    store: new SqliteWorldStore(createDb(transport)),
    host,
    newWorld: () => ({ seed: newWorld.seed, epoch: simInstant(newWorld.epochMs) }),
    onView: (view) => {
      post({ kind: 'view', view });
    },
  });
  runner = opened;
  post({ kind: 'view', view: opened.view() });
  timer = setInterval(() => {
    try {
      opened.advance();
    } catch (error) {
      fail(error);
    }
  }, ADVANCE_INTERVAL_MS);
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.kind) {
    case 'init':
      start(message.newWorld).catch(fail);
      break;
    case 'command':
      try {
        runner?.execute(message.command);
      } catch (error) {
        post({ kind: 'rejected', message: describe(error) });
      }
      break;
    case 'flush':
      (runner?.flush() ?? Promise.resolve())
        .catch(() => undefined)
        .finally(() => {
          post({ kind: 'flushed', id: message.id });
        });
      break;
    case 'sql:result': {
      const pending = pendingSql.get(message.id);
      pendingSql.delete(message.id);
      if (message.outcome.ok) {
        pending?.resolve(message.outcome.value);
      } else {
        pending?.reject(new Error(message.outcome.error));
      }
      break;
    }
  }
});
