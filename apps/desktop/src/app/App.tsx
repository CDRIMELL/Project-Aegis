import { AppFrame, NavItem } from '@aegis/ui';
import {
  Navigate,
  Outlet,
  RouterProvider,
  createHashRouter,
  useLocation,
  useNavigate,
} from 'react-router';
import { DataScreen } from '../features/data/DataScreen';
import { FleetScreen } from '../features/fleet/FleetScreen';
import { OperationsScreen } from '../features/operations/OperationsScreen';
import { SimClockBar } from '../features/sim-clock/SimClockBar';
import { SystemScreen } from '../features/system/SystemScreen';
import { AREAS, HOME_PATH, areaForPath } from './areas';

/** The persistent shell: navigation rail, top bar with the simulation clock, and the active area. */
function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = areaForPath(pathname);

  return (
    <AppFrame
      title={current?.label ?? ''}
      topBar={<SimClockBar />}
      railFooter={`Build ${__APP_VERSION__}`}
      bleed={current?.bleed ?? false}
      navigation={AREAS.map((area) => (
        <NavItem
          key={area.id}
          icon={area.icon}
          label={area.label}
          active={area.id === current?.id}
          {...(area.plannedPhase === null
            ? {
                onSelect: () => {
                  void navigate(area.path);
                },
              }
            : { unavailableReason: `Not built yet. Planned for phase ${area.plannedPhase}.` })}
        />
      ))}
    >
      <Outlet />
    </AppFrame>
  );
}

/*
 * Hash routing: the application is served from the bundle, where there is no server to rewrite
 * deep paths, and nothing outside the window ever needs to link into it.
 */
const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/operations', element: <OperationsScreen /> },
      { path: '/fleet/:aircraftId?', element: <FleetScreen /> },
      { path: '/data', element: <DataScreen /> },
      { path: '/system', element: <SystemScreen /> },
      { path: '*', element: <Navigate to={HOME_PATH} replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
