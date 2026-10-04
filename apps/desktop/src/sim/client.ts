import type { SqlTransport } from '@aegis/db';
import type { SimCommand } from '@aegis/sim';
import { simCommandRejected, simFailed, simViewReceived } from '../state/sim-store';
import type { FromWorker, SqlRequest, ToWorker } from './protocol';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  private nextFlushId = 1;

  start(transport: SqlTransport): void {
    if (this.worker) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;

    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      this.receive(event.data, transport);
    });
    worker.addEventListener('error', (event) => {
      simFailed(event.message || 'The simulation worker stopped unexpectedly.');
    });

    this.post({
      kind: 'init',
      newWorld: { seed: newSeed(), epochMs: Math.floor(Date.now() / 1000) * 1000 },
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
      const id = this.nextFlushId++;
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

  private receive(message: FromWorker, transport: SqlTransport): void {
    switch (message.kind) {
      case 'view':
        simViewReceived(message.view);
        break;
      case 'rejected':
        simCommandRejected(message.message);
        break;
      case 'failed':
        simFailed(message.message);
        break;
      case 'flushed':
        this.flushWaiters.get(message.id)?.();
        this.flushWaiters.delete(message.id);
        break;
      case 'sql:request':
        void this.relay(message.id, message.request, transport);
        break;
    }
  }

  private async relay(id: number, request: SqlRequest, transport: SqlTransport): Promise<void> {
    try {
      const value =
        request.op === 'query'
          ? await transport.query(request.statement)
          : await transport.batch(request.statements);
      this.post({ kind: 'sql:result', id, outcome: { ok: true, value } });
    } catch (error) {
      this.post({ kind: 'sql:result', id, outcome: { ok: false, error: describe(error) } });
    }
  }
}

export const simClient = new SimClient();
