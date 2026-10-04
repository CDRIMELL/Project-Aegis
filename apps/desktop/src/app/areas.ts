import {
  Activity,
  ChartColumn,
  Database,
  Earth,
  MapPin,
  Plane,
  Radar,
  Route,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type AreaId =
  | 'command'
  | 'operations'
  | 'missions'
  | 'fleet'
  | 'locations'
  | 'events'
  | 'reports'
  | 'data'
  | 'system';

export interface Area {
  readonly id: AreaId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Delivery phase from the implementation plan; `null` once the area exists. */
  readonly plannedPhase: number | null;
}

/**
 * Primary navigation, in display order. Areas that are not built yet are listed so the product's
 * shape is visible, but they render disabled with the reason: nothing here pretends to work.
 */
export const AREAS: readonly Area[] = [
  { id: 'command', label: 'Command', icon: Radar, plannedPhase: 6 },
  { id: 'operations', label: 'Operations', icon: Earth, plannedPhase: 3 },
  { id: 'missions', label: 'Missions', icon: Route, plannedPhase: 5 },
  { id: 'fleet', label: 'Fleet', icon: Plane, plannedPhase: 4 },
  { id: 'locations', label: 'Locations', icon: MapPin, plannedPhase: 3 },
  { id: 'events', label: 'Events', icon: Activity, plannedPhase: 6 },
  { id: 'reports', label: 'Reports', icon: ChartColumn, plannedPhase: 8 },
  { id: 'data', label: 'Data', icon: Database, plannedPhase: 8 },
  { id: 'system', label: 'System', icon: Settings, plannedPhase: null },
];
