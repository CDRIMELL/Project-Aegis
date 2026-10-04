/// Reference-data worker. Installs the bundled data pack off the UI thread (ADR 0013).
import { createDb } from '@aegis/db';
import { installPack, type PackReader } from '@aegis/ingest';
import { createRelayTransport } from '../platform/sql-relay';
import type { FromReferenceWorker, ToReferenceWorker } from './protocol';

function post(message: FromReferenceWorker): void {
  self.postMessage(message);
}

const relay = createRelayTransport(post);

/** Reads pack files from the application's own bundled assets. Never from a network. */
function bundledPack(baseUrl: string): PackReader {
  return {
    async readText(file) {
      const response = await fetch(`${baseUrl}/${file}`);
      if (!response.ok) {
        throw new Error(`Bundled reference data file ${file} is missing (HTTP ${response.status})`);
      }
      return response.text();
    },
  };
}

async function install(baseUrl: string): Promise<void> {
  const result = await installPack(createDb(relay.transport), bundledPack(baseUrl), {
    now: () => Date.now(),
    onDataset: (dataset, index, total) => {
      post({ kind: 'progress', dataset, index, total });
    },
  });
  if (result.status === 'failed') {
    post({ kind: 'failed', message: result.error });
    return;
  }
  post({
    kind: 'ready',
    manifestSha256: result.manifestSha256,
    installedNow: result.status === 'installed',
  });
}

self.addEventListener('message', (event: MessageEvent<ToReferenceWorker>) => {
  const message = event.data;
  if (message.kind === 'sql:result') {
    relay.receive(message);
    return;
  }
  install(message.baseUrl).catch((error: unknown) => {
    post({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  });
});
