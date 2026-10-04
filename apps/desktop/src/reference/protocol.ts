import type { SqlRequestMessage, SqlResultMessage } from '../platform/sql-relay';

/** Wire contract between the UI thread and the reference-data worker. */

export type ToReferenceWorker =
  /** Check the bundled pack against the database and install it if needed. */
  { readonly kind: 'install'; readonly baseUrl: string } | SqlResultMessage;

export type FromReferenceWorker =
  | {
      readonly kind: 'progress';
      readonly dataset: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly kind: 'ready';
      readonly manifestSha256: string;
      /** False when the database already held this pack and nothing was written. */
      readonly installedNow: boolean;
    }
  | { readonly kind: 'failed'; readonly message: string }
  | SqlRequestMessage;
