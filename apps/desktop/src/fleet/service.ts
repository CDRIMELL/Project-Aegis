import type { RoutePoint } from '@aegis/domain';
import { create } from 'zustand';
import { loadAerodrome, loadAircraftTypes } from '../reference/queries';
import { simClient } from '../sim/client';
import { useReferenceStore } from '../state/reference-store';
import { useSimStore } from '../state/sim-store';
import {
  STARTER_FLEET,
  buildCatalogue,
  orderFor,
  starterOrders,
  type AerodromeRow,
  type CatalogueEntry,
} from './catalogue';

/*
 * Application-side fleet services: the aircraft catalogue read from reference data, the one-time
 * starter fleet, and the commands the screens issue. Reference data is resolved here and handed
 * to the simulation as part of a command; the simulation never reads it (ADR 0016).
 */

interface CatalogueState {
  /** Reference aircraft types with their derived performance; `null` until loaded. */
  readonly entries: readonly CatalogueEntry[] | null;
  readonly error: string | null;
  /** Starter-fleet entries the reference data could not supply. */
  readonly starterMissing: readonly string[];
}

export const useCatalogueStore = create<CatalogueState>(() => ({
  entries: null,
  error: null,
  starterMissing: [],
}));

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function loadCatalogue(): Promise<void> {
  try {
    const { types, attributes } = await loadAircraftTypes();
    useCatalogueStore.setState({ entries: buildCatalogue(types, attributes), error: null });
  } catch (error) {
    useCatalogueStore.setState({ error: describe(error) });
  }
}

let seedRequested = false;

/** Gives a new world its starter fleet, once reference data and the simulation are both ready. */
async function seedStarterFleetIfNeeded(): Promise<void> {
  const view = useSimStore.getState().view;
  const { entries } = useCatalogueStore.getState();
  if (seedRequested || !view || view.fleet.starterFleetSeeded || !entries) return;
  seedRequested = true;
  try {
    const codes = [...new Set(STARTER_FLEET.map((entry) => entry.homeIcao))];
    const homes = (await Promise.all(codes.map((icao) => loadAerodrome({ icao })))).filter(
      (row): row is NonNullable<typeof row> => row !== null,
    );
    const { orders, missing } = starterOrders(entries, homes);
    useCatalogueStore.setState({ starterMissing: missing });
    simClient.send({ type: 'seedStarterFleet', aircraft: orders });
  } catch (error) {
    seedRequested = false;
    useCatalogueStore.setState({ error: describe(error) });
  }
}

/** Starts the services. Call once at start-up. */
export function startFleetServices(): void {
  const onReference = (phase: string) => {
    if (phase === 'ready' && useCatalogueStore.getState().entries === null) {
      void loadCatalogue().then(seedStarterFleetIfNeeded);
    }
  };
  onReference(useReferenceStore.getState().phase);
  useReferenceStore.subscribe((state) => {
    onReference(state.phase);
  });
  // The simulation may become ready after the catalogue.
  const stop = useSimStore.subscribe((state) => {
    if (state.view) {
      if (state.view.fleet.starterFleetSeeded) stop();
      else void seedStarterFleetIfNeeded();
    }
  });
}

export function acquireAircraft(entry: CatalogueEntry, home: RoutePoint): void {
  simClient.send({ type: 'acquireAircraft', ...orderFor(entry, home) });
}

export function setHome(aircraftId: string, home: RoutePoint): void {
  simClient.send({ type: 'setHome', aircraftId, home });
}

export function startMaintenance(aircraftId: string): void {
  simClient.send({ type: 'startMaintenance', aircraftId });
}

/** The reference aerodrome row needed to fly to a search result. */
export async function resolveAerodrome(id: string): Promise<AerodromeRow | null> {
  return loadAerodrome({ id });
}
