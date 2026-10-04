import type { SimCommand, SimView } from '@aegis/sim';
import type { SqlRequestMessage, SqlResultMessage } from '../platform/sql-relay';

/*
 * Wire contract between the UI thread and the simulation worker (ADR 0002).
 *
 * The worker owns the simulation and its persistence logic. Its SQL reaches the native core
 * through the relay in `platform/sql-relay.ts`.
 */

export type ToWorker =
  | {
      readonly kind: 'init';
      /** Used only if the database holds no world yet. */
      readonly newWorld: { readonly seed: string; readonly epochMs: number };
    }
  | { readonly kind: 'command'; readonly command: SimCommand }
  | { readonly kind: 'flush'; readonly id: number }
  | SqlResultMessage;

export type FromWorker =
  | { readonly kind: 'view'; readonly view: SimView }
  | { readonly kind: 'flushed'; readonly id: number }
  /** A command was refused; the simulation is unaffected. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The simulation cannot continue. */
  | { readonly kind: 'failed'; readonly message: string }
  | SqlRequestMessage;
