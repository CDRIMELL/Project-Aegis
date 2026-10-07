import type { Mission, MissionType } from '@aegis/domain';
import type { MissionConfiguration } from '@aegis/sim';
import { unclassifiedAerodromes } from '../fleet/ground-logic';
import { loadAerodromeSizes, loadLargeAerodromes } from '../reference/queries';
import { simClient } from '../sim/client';
import { useReferenceStore } from '../state/reference-store';
import { useSimStore } from '../state/sim-store';
import { chooseOperatingArea, fleetCentre, needsRecentre } from './operating-area';

/*
 * Application-side mission services: the one-time operating area, and the commands the screens
 * issue. Reference data is resolved here and handed to the simulation inside a command; the
 * simulation never reads it (ADR 0016, ADR 0017).
 */

/** The fleet's homes as last examined, so the area is reconsidered only when a home changes. */
let examinedHomes: string | null = null;
let areaRequested = false;

/**
 * Gives a world its operating area once it has a fleet to centre it on and reference data to take
 * it from, and chooses it afresh when the fleet's homes have moved 250 km or more (ADR 0022).
 * The replacement is one logged command; opportunities already offered are kept.
 */
async function setOperatingAreaIfNeeded(): Promise<void> {
  const view = useSimStore.getState().view;
  if (
    areaRequested ||
    !view ||
    view.fleet.aircraft.length === 0 ||
    useReferenceStore.getState().phase !== 'ready'
  ) {
    return;
  }
  // Look again only when a home aerodrome has changed, never on every update.
  const homes = view.fleet.aircraft.map((aircraft) => aircraft.home);
  // Keyed by the world as well: a new career is a new world with the same bases (ADR 0031).
  const homesKey = [
    view.seed,
    ...homes.map((home) => home.refId ?? `${home.lat},${home.lon}`),
  ].join('|');
  const hasArea = view.missions.operatingAreaSize > 0;
  if (hasArea && homesKey === examinedHomes) return;
  examinedHomes = homesKey;

  const centre = fleetCentre(homes);
  if (!centre) return;
  // A world gets an area once, and a new one only when its fleet has materially moved.
  if (hasArea && !needsRecentre(centre, view.missions.areaCentre)) return;

  areaRequested = true;
  try {
    const places = chooseOperatingArea(await loadLargeAerodromes(), homes);
    if (places.length > 0) simClient.send({ type: 'setOperatingArea', places, centre });
  } catch {
    // Look again on the next change of home; until then the world keeps the area it has.
    examinedHomes = null;
  } finally {
    areaRequested = false;
  }
}

/** Reference ids already looked up, so that an aerodrome the data lacks is not asked for again. */
const sizeLookedUp = new Set<string>();
let classifying = false;

/**
 * Gives aerodromes the world holds without a size class the class the packaged reference data
 * has for them (ADR 0029). A world from before the class was kept has none on its home bases,
 * its operating area or its open routes. Only what the reference data holds is sent; an
 * aerodrome it does not know keeps no class, and the simulation's medium fallback.
 */
async function classifyAerodromesIfNeeded(): Promise<void> {
  const view = useSimStore.getState().view;
  if (!view || classifying || useReferenceStore.getState().phase !== 'ready') return;
  const pending = unclassifiedAerodromes(view).filter((id) => !sizeLookedUp.has(id));
  if (pending.length === 0) return;
  classifying = true;
  try {
    const sizes = await loadAerodromeSizes(pending);
    for (const id of pending) sizeLookedUp.add(id);
    if (Object.keys(sizes).length > 0) simClient.send({ type: 'classifyAerodromes', sizes });
  } catch {
    // Looked up again on the next change; until then the world keeps what it has.
  } finally {
    classifying = false;
  }
}

/** Starts the services. Call once at start-up. */
export function startMissionServices(): void {
  let unclassified = '';
  const classify = () => {
    const view = useSimStore.getState().view;
    const now = view ? unclassifiedAerodromes(view).join() : '';
    if (now !== unclassified || now !== '') {
      unclassified = now;
      void classifyAerodromesIfNeeded();
    }
  };
  useSimStore.subscribe(classify);
  useReferenceStore.subscribe(classify);
  useSimStore.subscribe(() => {
    void setOperatingAreaIfNeeded();
  });
  useReferenceStore.subscribe(() => {
    void setOperatingAreaIfNeeded();
  });
  void setOperatingAreaIfNeeded();
}

export function createMission(type: MissionType, configuration: MissionConfiguration): void {
  simClient.send({ type: 'createMission', missionType: type, ...configuration });
}

export function updateMission(mission: Mission, configuration: MissionConfiguration): void {
  simClient.send({ type: 'updateMission', missionId: mission.id, ...configuration });
}

const command =
  (
    type:
      | 'acceptOffer'
      | 'rejectOffer'
      | 'acceptMission'
      | 'releaseMission'
      | 'cancelMission'
      | 'launchMission',
  ) =>
  (missionId: string): void => {
    simClient.send({ type, missionId });
  };

export const acceptOffer = command('acceptOffer');
export const rejectOffer = command('rejectOffer');
export const acceptMission = command('acceptMission');
export const releaseMission = command('releaseMission');
export const cancelMission = command('cancelMission');
export const launchMission = command('launchMission');
