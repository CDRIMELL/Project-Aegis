import type { Mission, MissionType } from '@aegis/domain';
import type { MissionConfiguration } from '@aegis/sim';
import { loadLargeAerodromes } from '../reference/queries';
import { simClient } from '../sim/client';
import { useReferenceStore } from '../state/reference-store';
import { useSimStore } from '../state/sim-store';
import { chooseOperatingArea } from './operating-area';

/*
 * Application-side mission services: the one-time operating area, and the commands the screens
 * issue. Reference data is resolved here and handed to the simulation inside a command; the
 * simulation never reads it (ADR 0016, ADR 0017).
 */

let areaRequested = false;

/**
 * Gives a world its operating area, once it has a fleet to centre it on and reference data to
 * take it from. A world keeps the area it was given.
 */
async function setOperatingAreaIfNeeded(): Promise<void> {
  const view = useSimStore.getState().view;
  if (
    areaRequested ||
    !view ||
    view.missions.operatingAreaSize > 0 ||
    view.fleet.aircraft.length === 0 ||
    useReferenceStore.getState().phase !== 'ready'
  ) {
    return;
  }
  areaRequested = true;
  try {
    const homes = view.fleet.aircraft.map((aircraft) => aircraft.home);
    const places = chooseOperatingArea(await loadLargeAerodromes(), homes);
    if (places.length > 0) simClient.send({ type: 'setOperatingArea', places });
    else areaRequested = false;
  } catch {
    // Try again on the next state update; without an area the world simply generates nothing.
    areaRequested = false;
  }
}

/** Starts the services. Call once at start-up. */
export function startMissionServices(): void {
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
