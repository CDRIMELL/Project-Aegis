import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDb } from '@aegis/db';
import { App } from './app/App';
import { startFleetServices } from './fleet/service';
import { startMissionServices } from './missions/service';
import { isDesktop, tauriTransport } from './platform/tauri';
import { ensureReferenceData } from './reference/client';
import { bindReferenceDb } from './reference/queries';
import { bindReportDb } from './reports/report-service';
import { simClient } from './sim/client';
import { bindSimDb } from './sim/log-queries';
import { useReferenceStore } from './state/reference-store';
import { simFailed } from './state/sim-store';
import './styles.css';

if (isDesktop()) {
  const database = createDb(tauriTransport);
  bindReferenceDb(database);
  bindSimDb(database);
  bindReportDb(database);
  simClient.start(tauriTransport);
  // First launch installs the reference data shipped in the bundle; later launches find it present.
  ensureReferenceData(tauriTransport);
  // Reads the aircraft catalogue and gives a new world its fleet.
  startFleetServices();
  // Gives the world its operating area, from which opportunities are generated.
  startMissionServices();
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
