import type { SqlTransport } from '@aegis/db';
import type { SimCommand } from '@aegis/sim';
import { serveSqlRequest } from '../platform/sql-relay';
import { simCommandRejected, simFailed, simViewReceived, simWorldAbsent } from '../state/sim-store';
import type { FromWorker, ToWorker } from './protocol';

/** A world seed only has to be unique, not secret. */
function newSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * UI-thread handle on the simulation worker.
 *
 * It starts the worker, relays its SQL to the native core, forwards user commands and publishes
 * the worker's state into the UI store. It contains no simulation logic.
 */
class SimClient {
  private worker: Worker | null = null;
  private readonly flushWaiters = new Map<number, () => void>();
  private readonly runs = new Map<
    number,
    { readonly done: () => void; readonly progress: (share: number) => void }
  >();
  private nextId = 1;

  /** Starts the worker and has it look for a saved world. It creates none (ADR 0031). */
  start(transport: SqlTransport): void {
    if (this.worker) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;

    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      this.receive(worker, event.data, transport);
    });
    worker.addEventListener('error', (event) => {
      simFailed(event.message || 'The simulation worker stopped unexpectedly.');
    });

    this.post({ kind: 'open' });
  }

  /**
   * Creates a world in place of the saved one. `epochMs` is the simulation instant of its first
   * tick. Returns the seed, by which the new world's first view is recognised.
   */
  create(epochMs: number): string {
    const seed = newSeed();
    this.post({ kind: 'create', newWorld: { seed, epochMs } });
    return seed;
  }

  /** The player is in the world: real time becomes simulation time. */
  enter(): void {
    this.post({ kind: 'enter' });
  }

  /** The player has left the world: it stops, and is persisted. */
  leave(): void {
    this.post({ kind: 'leave' });
  }

  /** Runs the world forward by exactly `steps`. Resolves when it has, and is on disk. */
  run(steps: number, progress: (share: number) => void = () => undefined): Promise<void> {
    if (!this.worker) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const id = this.nextId++;
      this.runs.set(id, { done: resolve, progress });
      this.post({ kind: 'run', id, steps });
    });
  }

  send(command: SimCommand): void {
    this.post({ kind: 'command', command });
  }

  /**
   * Asks the worker to persist unsaved state. Resolves when it has, or after `timeoutMs` so a
   * stalled worker can never prevent the window from closing.
   */
  flush(timeoutMs = 2000): Promise<void> {
    if (!this.worker) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.flushWaiters.delete(id);
        resolve();
      }, timeoutMs);
      this.flushWaiters.set(id, () => {
        clearTimeout(timeout);
        resolve();
      });
      this.post({ kind: 'flush', id });
    });
  }

  private post(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private receive(worker: Worker, message: FromWorker, transport: SqlTransport): void {
    switch (message.kind) {
      case 'view':
        simViewReceived(message.view);
        break;
      case 'empty':
        simWorldAbsent();
        break;
      case 'progress':
        this.runs.get(message.id)?.progress(message.of > 0 ? message.done / message.of : 1);
        break;
      case 'ran':
        this.runs.get(message.id)?.done();
        this.runs.delete(message.id);
        break;
      case 'rejected':
        simCommandRejected(message.message);
        break;
      case 'failed':
        simFailed(message.message);
        // Nothing more will come: whatever was waiting on the worker stops waiting.
        for (const run of this.runs.values()) run.done();
        this.runs.clear();
        break;
      case 'flushed':
        this.flushWaiters.get(message.id)?.();
        this.flushWaiters.delete(message.id);
        break;
      case 'sql:request':
        void serveSqlRequest(worker, message, transport);
        break;
    }
  }
}

export const simClient = new SimClient();
