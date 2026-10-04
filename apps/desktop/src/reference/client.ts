import type { SqlTransport } from '@aegis/db';
import { serveSqlRequest } from '../platform/sql-relay';
import { useReferenceStore } from '../state/reference-store';
import type { FromReferenceWorker, ToReferenceWorker } from './protocol';

/**
 * Makes sure the database holds the reference data shipped with this build (ADR 0013).
 *
 * Runs once at start-up. On a first launch it installs the bundled pack; on later launches it
 * finds the pack already installed and finishes at once. The worker is discarded afterwards.
 */
export function ensureReferenceData(transport: SqlTransport): void {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

  worker.addEventListener('message', (event: MessageEvent<FromReferenceWorker>) => {
    const message = event.data;
    switch (message.kind) {
      case 'sql:request':
        void serveSqlRequest(worker, message, transport);
        break;
      case 'progress':
        useReferenceStore.setState({
          phase: 'installing',
          dataset: message.dataset,
          step: message.index + 1,
          steps: message.total,
        });
        break;
      case 'ready':
        useReferenceStore.setState({
          phase: 'ready',
          manifestSha256: message.manifestSha256,
          installedNow: message.installedNow,
        });
        worker.terminate();
        break;
      case 'failed':
        useReferenceStore.setState({ phase: 'failed', error: message.message });
        worker.terminate();
        break;
    }
  });
  worker.addEventListener('error', (event) => {
    useReferenceStore.setState({
      phase: 'failed',
      error: event.message || 'The reference-data worker stopped unexpectedly.',
    });
  });

  const start: ToReferenceWorker = {
    kind: 'install',
    baseUrl: `${window.location.origin}/reference-pack`,
  };
  worker.postMessage(start);
}
