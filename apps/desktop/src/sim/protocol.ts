import type { SimCommand, SimView } from '@aegis/sim';
import type { SqlRequestMessage, SqlResultMessage } from '../platform/sql-relay';

/*
 * Wire contract between the UI thread and the simulation worker (ADR 0002).
 *
 * The worker owns the simulation and its persistence logic. Its SQL reaches the native core
 * through the relay in `platform/sql-relay.ts`.
 *
 * A world is opened or created only when asked for, and advanced only while the player is in it
 * (ADR 0031): the application starts at a menu, and nothing runs behind it.
 */

export type ToWorker =
  /** Loads the saved world, if there is one. Answered with `view` or `empty`. */
  | { readonly kind: 'open' }
  /** Creates a world in place of whatever is saved. Answered with `view`. */
  | {
      readonly kind: 'create';
      readonly newWorld: { readonly seed: string; readonly epochMs: number };
    }
  /** Begins converting real time into simulation steps. */
  | { readonly kind: 'enter' }
  /** Stops converting real time into steps, and persists what there is. */
  | { readonly kind: 'leave' }
  /** Runs the world forward by exactly this many steps. Answered with `progress`, then `ran`. */
  | { readonly kind: 'run'; readonly id: number; readonly steps: number }
  | { readonly kind: 'command'; readonly command: SimCommand }
  | { readonly kind: 'flush'; readonly id: number }
  | SqlResultMessage;

export type FromWorker =
  | { readonly kind: 'view'; readonly view: SimView }
  /** The database holds no world. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'progress'; readonly id: number; readonly done: number; readonly of: number }
  | { readonly kind: 'ran'; readonly id: number }
  | { readonly kind: 'flushed'; readonly id: number }
  /** A command was refused; the simulation is unaffected. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The simulation cannot continue. */
  | { readonly kind: 'failed'; readonly message: string }
  | SqlRequestMessage;
