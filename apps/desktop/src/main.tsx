import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDb } from '@aegis/db';
import { App } from './app/App';
import { isDesktop, tauriTransport } from './platform/tauri';
import { ensureReferenceData } from './reference/client';
import { bindReferenceDb } from './reference/queries';
import { simClient } from './sim/client';
import { useReferenceStore } from './state/reference-store';
import { simFailed } from './state/sim-store';
import './styles.css';

if (isDesktop()) {
  bindReferenceDb(createDb(tauriTransport));
  simClient.start(tauriTransport);
  // First launch installs the reference data shipped in the bundle; later launches find it present.
  ensureReferenceData(tauriTransport);
  // Persist unsaved simulation state before the window goes away (ADR 0004).
  void getCurrentWindow().onCloseRequested(async () => {
    await simClient.flush();
  });
} else {
  const message =
    'AEGIS is a desktop application. Its native core is not available in a browser tab.';
  simFailed(message);
  useReferenceStore.setState({ phase: 'failed', error: message });
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element is missing from index.html');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
