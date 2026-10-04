import { loadMapLocations, loadMapRunways } from '../reference/queries';
import { select, useMapStore } from '../state/map-store';
import { useReferenceStore } from '../state/reference-store';
import { mapController } from './controller';
import { locationFeatures, runwayFeatures } from './features';
import { CONTINENTS, countryFrames, type CountryFrame } from './geography';
import { LAYER_GROUPS, type LayerGroup } from './style';

/*
 * Connects application state to the map engine, outside React (ADR 0014).
 *
 * State changes are pushed into the controller here, so no component re-renders to move the
 * camera, change a layer or mark a selection.
 */

/** Position of every loaded location, for marking a selection without another query. */
const positions = new Map<string, { lat: number; lon: number }>();
let frames = new Map<string, CountryFrame>();
let started = false;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function loadReference(): Promise<void> {
  const controller = mapController();
  try {
    const [, locations, runways] = await Promise.all([
      controller.whenReady(),
      loadMapLocations(),
      loadMapRunways(),
    ]);
    for (const row of locations) positions.set(row.id, { lat: row.lat, lon: row.lon });
    controller.setLocations(locationFeatures(locations));
    controller.setRunways(runwayFeatures(runways));
    useMapStore.setState({ referenceLoaded: true, referenceError: null });
    applySelection();
  } catch (error) {
    useMapStore.setState({ referenceError: describe(error) });
  }
}

async function loadCountryFrames(): Promise<void> {
  const response = await fetch(`${window.location.origin}/basemap/country-labels.json`);
  frames = countryFrames((await response.json()) as Parameters<typeof countryFrames>[0]);
}

function applySelection(): void {
  const { selection } = useMapStore.getState();
  if (selection?.type === 'location') {
    const position = positions.get(selection.id);
    mapController().setSelection(position ? { ...selection, ...position } : null);
  } else {
    // A selected aircraft is marked by its own layer, which follows it as it moves.
    mapController().setSelection(selection?.type === 'country' ? selection : null);
  }
}

/** Starts the bindings. Safe to call more than once; only the first call has an effect. */
export function startMapBinding(): void {
  if (started) return;
  started = true;
  const controller = mapController();

  controller.onPick((pick) => {
    select(pick);
  });

  useMapStore.subscribe((state, previous) => {
    if (state.selection !== previous.selection) applySelection();
    for (const group of Object.keys(LAYER_GROUPS) as LayerGroup[]) {
      if (state.visible[group] !== previous.visible[group]) {
        controller.setGroupVisible(group, state.visible[group]);
      }
    }
  });

  // Reference features are read once the bundled pack is confirmed installed.
  if (useReferenceStore.getState().phase === 'ready') {
    void loadReference();
  } else {
    const stop = useReferenceStore.subscribe((state) => {
      if (state.phase === 'ready') {
        stop();
        void loadReference();
      }
    });
  }
  void loadCountryFrames().catch(() => undefined);
}

/** Selects a location and brings it into view. */
export function focusLocation(id: string, lat: number, lon: number, zoom: number): void {
  positions.set(id, { lat, lon });
  select({ type: 'location', id });
  mapController().flyTo(lat, lon, zoom);
}

/** Selects a country and frames it. */
export function focusCountry(iso2: string): void {
  select({ type: 'country', iso2 });
  const frame = frames.get(iso2);
  if (!frame) return;
  if (frame.bounds) {
    mapController().fitBounds(...frame.bounds);
  } else {
    mapController().flyTo(frame.lat, frame.lon, 3);
  }
}

export function focusContinent(code: string): void {
  const continent = CONTINENTS[code];
  if (continent) mapController().fitBounds(...continent.frame);
}

/** Zoom that suits each kind of place when jumping to it. */
export function focusZoom(kind: string): number {
  switch (kind) {
    case 'airport_large':
      return 11;
    case 'airport_medium':
      return 11.5;
    case 'airport_small':
      return 12;
    default:
      return 9;
  }
}
