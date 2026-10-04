import {
  ChartColumn,
  Database,
  Earth,
  Gauge,
  Plane,
  Route,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export type AreaId =
  'overview' | 'operations' | 'fleet' | 'missions' | 'reports' | 'data' | 'system';

export interface Area {
  readonly id: AreaId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Route path once the area exists. */
  readonly path: `/${string}`;
  /** Delivery phase from the implementation plan; `null` once the area exists. */
  readonly plannedPhase: number | null;
  /** The area fills the content region edge to edge (the map). */
  readonly bleed?: boolean;
}

/**
 * Primary navigation, in display order. Areas that are not built yet are listed so the product's
 * shape is visible, but they render disabled with the reason and have no route: nothing here
 * pretends to work.
 */
export const AREAS: readonly Area[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, path: '/overview', plannedPhase: 6 },
  {
    id: 'operations',
    label: 'Operations',
    icon: Earth,
    path: '/operations',
    plannedPhase: null,
    bleed: true,
  },
  { id: 'fleet', label: 'Fleet', icon: Plane, path: '/fleet', plannedPhase: null, bleed: true },
  {
    id: 'missions',
    label: 'Missions',
    icon: Route,
    path: '/missions',
    plannedPhase: null,
    bleed: true,
  },
  { id: 'reports', label: 'Reports', icon: ChartColumn, path: '/reports', plannedPhase: 8 },
  { id: 'data', label: 'Data', icon: Database, path: '/data', plannedPhase: null },
  { id: 'system', label: 'System', icon: Settings, path: '/system', plannedPhase: null },
];

/** Where the application opens. */
export const HOME_PATH = '/operations';

export function areaForPath(pathname: string): Area | undefined {
  return AREAS.find((area) => area.plannedPhase === null && pathname.startsWith(area.path));
}
