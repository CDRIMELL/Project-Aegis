import type { Mission } from '@aegis/domain';
import { select, useMapStore } from '../state/map-store';
import { useSimStore } from '../state/sim-store';
import { mapController } from './controller';
import { missionBounds, missionFeatures, missionFeaturesKey } from './mission-features';
import { FONT_MONO } from './style';

/*
 * Feeds missions into the map's simulation tier, outside React (ADR 0014, ADR 0017). Mission
 * geometry changes only when a mission is created, edited or changes state, so it is redrawn then
 * and not on every simulation update. Aircraft movement stays with the flight binding.
 */

let started = false;

export function startMissionBinding(): void {
  if (started) return;
  started = true;
  const controller = mapController();

  void controller.whenReady().then(() => {
    const palette = controller.colors;

    const areas = controller.addSimulationSource('mission-areas', [
      {
        id: 'fill',
        type: 'fill',
        source: '',
        paint: {
          'fill-color': palette.simulated,
          'fill-opacity': ['case', ['get', 'selected'], 0.1, 0.04],
        },
      },
      {
        id: 'outline',
        type: 'line',
        source: '',
        paint: {
          'line-color': palette.simulated,
          'line-width': ['case', ['get', 'selected'], 1.5, 1],
          'line-opacity': ['case', ['get', 'selected'], 0.9, 0.5],
          'line-dasharray': [2, 2],
        },
      },
    ]);
    const routes = controller.addSimulationSource('mission-routes', [
      {
        id: 'line',
        type: 'line',
        source: '',
        // An active mission's route is already drawn, solid, as its flight's route.
        filter: ['!', ['boolean', ['get', 'active'], false]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.simulated,
          'line-width': ['case', ['get', 'selected'], 2, 1.25],
          'line-opacity': ['case', ['get', 'selected'], 0.9, 0.4],
          'line-dasharray': [3, 2],
        },
      },
    ]);
    const points = controller.addSimulationSource('mission-points', [
      {
        id: 'marker',
        type: 'circle',
        source: '',
        paint: {
          'circle-radius': ['match', ['get', 'role'], 'waypoint', 2.5, 4],
          'circle-color': ['match', ['get', 'role'], 'waypoint', palette.simulated, palette.water],
          'circle-stroke-color': palette.simulated,
          'circle-stroke-width': 1.25,
          'circle-opacity': ['case', ['get', 'selected'], 1, 0.6],
          'circle-stroke-opacity': ['case', ['get', 'selected'], 1, 0.6],
        },
      },
      {
        id: 'label',
        type: 'symbol',
        source: '',
        filter: ['!=', ['get', 'label'], ''],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': [FONT_MONO],
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          'text-optional': true,
        },
        paint: {
          'text-color': palette.simulated,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.25,
          'text-opacity': ['case', ['get', 'selected'], 1, 0.7],
        },
      },
    ]);

    let drawnKey: string | null = null;
    const draw = (): void => {
      const missions = useSimStore.getState().view?.missions.missions ?? [];
      const { selection } = useMapStore.getState();
      const selectedId = selection?.type === 'mission' ? selection.id : null;
      const key = missionFeaturesKey(missions, selectedId);
      if (key === drawnKey) return;
      drawnKey = key;
      const features = missionFeatures(missions, selectedId);
      areas.set(features.areas);
      routes.set(features.routes);
      points.set(features.points);
    };

    draw();
    useSimStore.subscribe((state, previous) => {
      if (state.view?.missions !== previous.view?.missions) draw();
    });
    useMapStore.subscribe((state, previous) => {
      if (state.selection !== previous.selection) draw();
    });
  });
}

/** Selects a mission on the map and brings everything it draws into view. */
export function focusMission(mission: Mission): void {
  select({ type: 'mission', id: mission.id });
  const bounds = missionBounds(mission);
  if (bounds) mapController().fitBounds(...bounds);
}
