import { create } from 'zustand';
import type { LayerGroup } from '../map/style';

/*
 * UI state of the map screen: what is selected and which layer groups are shown.
 * It holds no map data. Features live in MapLibre sources, owned by the map controller.
 */

export type Selection =
  | { readonly type: 'aircraft'; readonly id: string }
  | { readonly type: 'mission'; readonly id: string }
  | { readonly type: 'location'; readonly id: string }
  | { readonly type: 'country'; readonly iso2: string }
  | null;

interface MapState {
  readonly selection: Selection;
  readonly visible: Readonly<Record<LayerGroup, boolean>>;
  /** Simulated weather layers. Off or sparse by default, so the map is not cluttered. */
  readonly weatherLayers: { readonly wind: boolean; readonly precipitation: boolean };
  /** Whether reference features have been loaded into the map. */
  readonly referenceLoaded: boolean;
  readonly referenceError: string | null;
}

export const useMapStore = create<MapState>(() => ({
  selection: null,
  visible: {
    aerodromes: true,
    runways: true,
    cities: true,
    countryNames: true,
    borders: true,
    graticule: true,
  },
  weatherLayers: { wind: false, precipitation: true },
  referenceLoaded: false,
  referenceError: null,
}));

export function select(selection: Selection): void {
  useMapStore.setState({ selection });
}

export function setGroupVisible(group: LayerGroup, visible: boolean): void {
  useMapStore.setState((state) => ({ visible: { ...state.visible, [group]: visible } }));
}

export function setWeatherLayer(layer: 'wind' | 'precipitation', visible: boolean): void {
  useMapStore.setState((state) => ({
    weatherLayers: { ...state.weatherLayers, [layer]: visible },
  }));
}
