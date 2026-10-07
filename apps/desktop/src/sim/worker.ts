/// Simulation worker entry point. Runs the engine off the UI thread (ADR 0002).
import { createDb, SqliteWorldStore } from '@aegis/db';
import { simInstant } from '@aegis/domain';
import { SimulationRunner, type HostClock, type SimView } from '@aegis/sim';
import { createRelayTransport } from '../platform/sql-relay';
import type { FromWorker, ToWorker } from './protocol';

/** How often real elapsed time is converted into simulation steps. */
const ADVANCE_INTERVAL_MS = 100;
/** Steps run at a time when the world is run forward on request, between progress reports. */
const RUN_SLICE_STEPS = 600;

function post(message: FromWorker): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const relay = createRelayTransport(post);
const store = new SqliteWorldStore(createDb(relay.transport));

const host: HostClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
};

let runner: SimulationRunner | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function stopAdvancing(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function fail(error: unknown): void {
  stopAdvancing();
  runner = null;
  post({ kind: 'failed', message: describe(error) });
}

const onView = (view: SimView) => {
  post({ kind: 'view', view });
};

/** Loads the saved world without creating one (ADR 0031). */
async function open(): Promise<void> {
  runner = await SimulationRunner.load({ store, host, onView });
  if (runner) post({ kind: 'view', view: runner.view() });
  else post({ kind: 'empty' });
}

/** Replaces whatever is saved with a new world. */
async function create(newWorld: { seed: string; epochMs: number }): Promise<void> {
  stopAdvancing();
  if (runner) await runner.flush();
  runner = null;
  runner = await SimulationRunner.create({
    store,
    host,
    newWorld: () => ({ seed: newWorld.seed, epoch: simInstant(newWorld.epochMs) }),
    onView,
  });
  post({ kind: 'view', view: runner.view() });
}

/** The player is in the world: real time becomes simulation steps from now. */
function enter(): void {
  const current = runner;
  if (!current || timer !== null) return;
  // Time spent at the menu is not paid back as steps.
  current.resync();
  timer = setInterval(() => {
    try {
      current.advance();
    } catch (error) {
      fail(error);
    }
  }, ADVANCE_INTERVAL_MS);
}

/** Runs the world forward in slices, so that progress is reported and messages are answered. */
async function run(id: number, steps: number): Promise<void> {
  const current = runner;
  if (!current) {
    post({ kind: 'ran', id });
    return;
  }
  for (let done = 0; done < steps;) {
    const slice = Math.min(RUN_SLICE_STEPS, steps - done);
    current.fastForward(slice);
    done += slice;
    post({ kind: 'progress', id, done, of: steps });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await current.flush();
  post({ kind: 'ran', id });
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.kind) {
    case 'open':
      open().catch(fail);
      break;
    case 'create':
      create(message.newWorld).catch(fail);
      break;
    case 'enter':
      enter();
      break;
    case 'leave':
      stopAdvancing();
      void runner?.flush();
      break;
    case 'run':
      run(message.id, message.steps).catch(fail);
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
