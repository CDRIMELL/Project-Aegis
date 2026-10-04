import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { isDesktop, tauriTransport } from './platform/tauri';
import { simClient } from './sim/client';
import { simFailed } from './state/sim-store';
import './styles.css';

if (isDesktop()) {
  simClient.start(tauriTransport);
  // Persist unsaved simulation state before the window goes away (ADR 0004).
  void getCurrentWindow().onCloseRequested(async () => {
    await simClient.flush();
  });
} else {
  simFailed('AEGIS is a desktop application. Its native core is not available in a browser tab.');
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
