import type { FlightView, SimView } from '@aegis/sim';
import { insertWaypoint, moveWaypoint, removeWaypoint } from '../fleet/plan-edit';
import { followAircraft } from '../operations/inflight-logic';
import { select, useMapStore } from '../state/map-store';
import { editDraft, usePlanStore } from '../state/plan-store';
import { useSimStore } from '../state/sim-store';
import { mapController } from './controller';
import {
  activeRouteFeatures,
  aircraftFeatures,
  draftFeatures,
  interpolateAircraft,
  type AircraftSample,
  type SamplePair,
} from './flight-features';

/*
 * Feeds simulated aircraft, their routes and the draft plan into the map, outside React
 * (ADR 0014). The simulation publishes state about ten times a second; between updates the
 * aircraft are drawn every animation frame by interpolating along their own routes. That
 * smoothing is display only: nothing here is read back by the simulation.
 */

let started = false;

export function startFlightBinding(): void {
  if (started) return;
  started = true;
  const controller = mapController();

  /** Last two reported states of each airborne aircraft, keyed by aircraft id. */
  const pairs = new Map<string, SamplePair>();
  let frame: number | null = null;
  let routesKey = '';

  const highlighted = (): string | null => {
    const { selection } = useMapStore.getState();
    if (selection?.type === 'aircraft') return selection.id;
    if (selection?.type === 'mission') {
      // A selected mission highlights the aircraft flying it.
      const mission = useSimStore
        .getState()
        .view?.missions.missions.find((candidate) => candidate.id === selection.id);
      if (mission?.aircraftId) return mission.aircraftId;
    }
    return usePlanStore.getState().planningAircraftId;
  };

  const drawAircraft = (): void => {
    const view = useSimStore.getState().view;
    const now = performance.now();
    const samples: AircraftSample[] = [];
    for (const aircraft of view?.fleet.aircraft ?? []) {
      if (aircraft.location) {
        samples.push({
          aircraftId: aircraft.id,
          lat: aircraft.location.lat,
          lon: aircraft.location.lon,
          headingDeg: 0,
        });
      }
    }
    for (const pair of pairs.values()) samples.push(interpolateAircraft(pair, now));
    controller.setAircraft(aircraftFeatures(samples, highlighted()));
    frame = pairs.size > 0 ? requestAnimationFrame(drawAircraft) : null;
  };

  const drawRoutes = (flights: readonly FlightView[]): void => {
    const selected = highlighted();
    // Redrawn when a flight starts or ends, a route is changed, the selection moves, or an
    // aircraft has covered another fiftieth of its route: the flown part is drawn dimmer.
    const key = `${flights
      .map(
        (flight) =>
          `${flight.id}:${flight.revisions.length}:${Math.floor((flight.distanceM / Math.max(flight.totalM, 1)) * 50)}`,
      )
      .join(',')}|${selected ?? ''}`;
    if (key === routesKey) return;
    routesKey = key;
    controller.setFlightRoutes(activeRouteFeatures(flights, selected));
  };

  const onView = (view: SimView | null): void => {
    const flights = view?.fleet.activeFlights ?? [];
    const now = performance.now();
    const airborne = new Set<string>();
    for (const flight of flights) {
      airborne.add(flight.aircraftId);
      const known = pairs.get(flight.aircraftId);
      pairs.set(flight.aircraftId, {
        previous: known?.latest ?? flight,
        latest: flight,
        previousAtMs: known?.latestAtMs ?? now,
        latestAtMs: now,
      });
    }
    for (const id of pairs.keys()) {
      if (!airborne.has(id)) pairs.delete(id);
    }
    drawRoutes(flights);
    // A draft of the rest of a flight starts where the aircraft is, and follows it.
    const plan = usePlanStore.getState();
    const revised = plan.revision
      ? flights.find((flight) => flight.aircraftId === plan.planningAircraftId)
      : undefined;
    if (revised && plan.draft) {
      const followed = followAircraft(plan.draft, revised);
      if (followed !== plan.draft) usePlanStore.setState({ draft: followed });
    } else if (plan.revision && plan.planningAircraftId && !revised && view) {
      // The flight landed while its route was being changed: there is nothing left to change.
      usePlanStore.setState({ planningAircraftId: null, draft: null, revision: null });
    }
    // While nothing is flying there is no animation loop; draw once per update instead.
    if (frame === null) drawAircraft();
  };

  const drawDraft = (): void => {
    const { route, handles } = draftFeatures(usePlanStore.getState().draft?.plan.points ?? []);
    controller.setDraft(route, handles);
  };

  void controller.whenReady().then(() => {
    onView(useSimStore.getState().view);
    drawDraft();

    useSimStore.subscribe((state, previous) => {
      if (state.view !== previous.view) onView(state.view);
    });
    const onHighlight = (): void => {
      drawRoutes(useSimStore.getState().view?.fleet.activeFlights ?? []);
      if (frame === null) drawAircraft();
    };
    useMapStore.subscribe((state, previous) => {
      if (state.selection !== previous.selection) onHighlight();
    });
    usePlanStore.subscribe((state, previous) => {
      if (state.draft !== previous.draft) drawDraft();
      if (state.planningAircraftId !== previous.planningAircraftId) onHighlight();
    });

    // Edits made on the map go through the same functions as edits made in the panel.
    controller.onDraftEdit((edit) => {
      editDraft((draft) => {
        switch (edit.type) {
          case 'move':
            return moveWaypoint(draft, edit.index, edit.lat, edit.lon);
          case 'insert':
            return insertWaypoint(draft, edit.afterIndex, edit);
          case 'remove':
            return removeWaypoint(draft, edit.index);
        }
      });
    });
  });
}

/** Selects an aircraft and, if it is on the ground or flying, brings it into view. */
export function focusAircraft(aircraftId: string): void {
  select({ type: 'aircraft', id: aircraftId });
  const view = useSimStore.getState().view;
  const flight = view?.fleet.activeFlights.find((candidate) => candidate.aircraftId === aircraftId);
  const ground = view?.fleet.aircraft.find((candidate) => candidate.id === aircraftId)?.location;
  const at = flight ?? ground;
  if (at) mapController().flyTo(at.lat, at.lon, 5);
}
