import type { SqlResult, SqlStatement } from '@aegis/db';
import type { SimCommand, SimView } from '@aegis/sim';

/*
 * Wire contract between the UI thread and the simulation worker (ADR 0002).
 *
 * The worker owns the simulation and its persistence logic. It cannot call Tauri itself, so SQL
 * travels to the UI thread as `sql:request` and comes back as `sql:result`. The UI thread relays
 * those messages unchanged; it never interprets or alters them.
 */

export type ToWorker =
  | {
      readonly kind: 'init';
      /** Used only if the database holds no world yet. */
      readonly newWorld: { readonly seed: string; readonly epochMs: number };
    }
  | { readonly kind: 'command'; readonly command: SimCommand }
  | { readonly kind: 'flush'; readonly id: number }
  | {
      readonly kind: 'sql:result';
      readonly id: number;
      readonly outcome:
        | { readonly ok: true; readonly value: SqlResult | SqlResult[] }
        | { readonly ok: false; readonly error: string };
    };

export type SqlRequest =
  | { readonly op: 'query'; readonly statement: SqlStatement }
  | { readonly op: 'batch'; readonly statements: readonly SqlStatement[] };

export type FromWorker =
  | { readonly kind: 'view'; readonly view: SimView }
  | { readonly kind: 'flushed'; readonly id: number }
  /** A command was refused; the simulation is unaffected. */
  | { readonly kind: 'rejected'; readonly message: string }
  /** The simulation cannot continue. */
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'sql:request'; readonly id: number; readonly request: SqlRequest };
