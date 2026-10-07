import { FLIGHT_MODEL_VERSION, type RoutePoint } from '@aegis/domain';
import { create } from 'zustand';
import { loadAerodrome, loadAircraftTypes } from '../reference/queries';
import { simClient } from '../sim/client';
import { useReferenceStore } from '../state/reference-store';
import { useSimStore } from '../state/sim-store';
import {
  CAREER_FLEET,
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

/** The world a fleet has been asked for, by seed: a new world is given its own (ADR 0031). */
let seedRequestedFor: string | null = null;

/**
 * Gives a new world its fleet, once reference data and the simulation are both ready. Every
 * world the application creates is a career, so it is given the career fleet.
 */
async function seedStarterFleetIfNeeded(): Promise<void> {
  const view = useSimStore.getState().view;
  const { entries } = useCatalogueStore.getState();
  if (!view || seedRequestedFor === view.seed || view.fleet.starterFleetSeeded || !entries) return;
  seedRequestedFor = view.seed;
  try {
    const codes = [...new Set(CAREER_FLEET.map((entry) => entry.homeIcao))];
    const homes = (await Promise.all(codes.map((icao) => loadAerodrome({ icao })))).filter(
      (row): row is NonNullable<typeof row> => row !== null,
    );
    const { orders, missing } = starterOrders(entries, homes, CAREER_FLEET);
    useCatalogueStore.setState({ starterMissing: missing });
    simClient.send({ type: 'seedStarterFleet', aircraft: orders });
  } catch (error) {
    seedRequestedFor = null;
    useCatalogueStore.setState({ error: describe(error) });
  }
}

/** Aircraft already asked to take the current model, so a request is not repeated every view. */
const migrationRequested = new Set<string>();

/**
 * Moves grounded aircraft onto the current flight model (ADR 0019). An aircraft is migrated when
 * its stored model is from an older version, or when it had none and the reference data can now
 * support one. Airborne aircraft, and those being serviced, are left alone and picked up after.
 */
function migratePerformanceIfNeeded(): void {
  const view = useSimStore.getState().view;
  const { entries } = useCatalogueStore.getState();
  if (!view || !entries) return;
  const byType = new Map(entries.map((entry) => [entry.type.id, entry]));
  for (const aircraft of view.fleet.aircraft) {
    const entry = byType.get(aircraft.typeId);
    // An aircraft being serviced takes a new model once that is done (ADR 0027).
    if (!entry || aircraft.location === null || aircraft.status === 'servicing') continue;
    const latest = entry.performance.available ? entry.performance.model : null;
    const outdated =
      aircraft.performance === null
        ? latest !== null
        : latest !== null && aircraft.performance.modelVersion < FLIGHT_MODEL_VERSION;
    if (!outdated) continue;
    const request = `${view.seed}:${aircraft.id}:${FLIGHT_MODEL_VERSION}`;
    if (migrationRequested.has(request)) continue;
    migrationRequested.add(request);
    simClient.send({
      type: 'updatePerformance',
      aircraftId: aircraft.id,
      performance: latest,
      performanceMissing: [],
    });
  }
}

/** Starts the services. Call once at start-up. */
export function startFleetServices(): void {
  const onReference = (phase: string) => {
    if (phase === 'ready' && useCatalogueStore.getState().entries === null) {
      void loadCatalogue().then(seedStarterFleetIfNeeded).then(migratePerformanceIfNeeded);
    }
  };
  onReference(useReferenceStore.getState().phase);
  useReferenceStore.subscribe((state) => {
    onReference(state.phase);
  });
  // Aircraft that were airborne are migrated once they are back on the ground.
  let grounded = '';
  useSimStore.subscribe((state) => {
    const now =
      state.view?.fleet.aircraft
        .filter((aircraft) => aircraft.location !== null)
        .map((aircraft) => aircraft.id)
        .join() ?? '';
    if (now !== grounded) {
      grounded = now;
      migratePerformanceIfNeeded();
    }
  });
  // The simulation may become ready after the catalogue, and a new career brings a new world.
  useSimStore.subscribe((state) => {
    if (state.view && !state.view.fleet.starterFleetSeeded) void seedStarterFleetIfNeeded();
  });
}

export function acquireAircraft(entry: CatalogueEntry, home: RoutePoint): void {
  simClient.send({ type: 'acquireAircraft', ...orderFor(entry, home) });
}

export function setHome(aircraftId: string, home: RoutePoint): void {
  simClient.send({ type: 'setHome', aircraftId, home });
}

/**
 * Brings a grounded aircraft's fuel, and its payload if one is given, to a quantity over
 * simulated time (ADR 0027, ADR 0028).
 */
export function serviceAircraft(aircraftId: string, fuelKg: number, payloadKg?: number): void {
  simClient.send({
    type: 'serviceAircraft',
    aircraftId,
    fuelKg,
    ...(payloadKg !== undefined && { payloadKg }),
  });
}

export function stopServicing(aircraftId: string): void {
  simClient.send({ type: 'stopServicing', aircraftId });
}

export function startMaintenance(aircraftId: string): void {
  simClient.send({ type: 'startMaintenance', aircraftId });
}

/** The reference aerodrome row needed to fly to a search result. */
export async function resolveAerodrome(id: string): Promise<AerodromeRow | null> {
  return loadAerodrome({ id });
}
