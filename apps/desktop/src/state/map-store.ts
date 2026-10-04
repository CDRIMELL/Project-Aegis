import { create } from 'zustand';
import type { LayerGroup } from '../map/style';

/*
 * UI state of the map screen: what is selected and which layer groups are shown.
 * It holds no map data. Features live in MapLibre sources, owned by the map controller.
 */

export type Selection =
  | { readonly type: 'location'; readonly id: string }
  | { readonly type: 'country'; readonly iso2: string }
  | null;

interface MapState {
  readonly selection: Selection;
  readonly visible: Readonly<Record<LayerGroup, boolean>>;
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
  referenceLoaded: false,
  referenceError: null,
}));

export function select(selection: Selection): void {
  useMapStore.setState({ selection });
}

export function setGroupVisible(group: LayerGroup, visible: boolean): void {
  useMapStore.setState((state) => ({ visible: { ...state.visible, [group]: visible } }));
}
