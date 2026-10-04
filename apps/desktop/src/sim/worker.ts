/// Simulation worker entry point. Runs the engine off the UI thread (ADR 0002).
import { createDb, SqliteWorldStore } from '@aegis/db';
import { simInstant } from '@aegis/domain';
import { SimulationRunner, type HostClock } from '@aegis/sim';
import { createRelayTransport } from '../platform/sql-relay';
import type { FromWorker, ToWorker } from './protocol';

/** How often real elapsed time is converted into simulation steps. */
const ADVANCE_INTERVAL_MS = 100;

function post(message: FromWorker): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const relay = createRelayTransport(post);

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
    store: new SqliteWorldStore(createDb(relay.transport)),
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
    case 'sql:result':
      relay.receive(message);
      break;
  }
});
