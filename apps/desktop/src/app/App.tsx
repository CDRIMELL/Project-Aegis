import { AppFrame, NavItem } from '@aegis/ui';
import {
  Navigate,
  Outlet,
  RouterProvider,
  createHashRouter,
  useLocation,
  useNavigate,
} from 'react-router';
import { CareerScreen } from '../features/career/CareerScreen';
import { CommandSummary } from '../features/career/CommandSummary';
import { DailyBrief } from '../features/career/DailyBrief';
import { HowToPlay } from '../features/career/HowToPlay';
import { MainMenu } from '../features/career/MainMenu';
import { NewCareer } from '../features/career/NewCareer';
import { SettingsFront } from '../features/career/SettingsFront';
import { DataScreen } from '../features/data/DataScreen';
import { FleetScreen } from '../features/fleet/FleetScreen';
import { MissionsScreen } from '../features/missions/MissionsScreen';
import { OperationsScreen } from '../features/operations/OperationsScreen';
import { OverviewScreen } from '../features/overview/OverviewScreen';
import { ReportsScreen } from '../features/reports/ReportsScreen';
import { SimClockBar } from '../features/sim-clock/SimClockBar';
import { SystemScreen } from '../features/system/SystemScreen';
import { useSessionStore } from '../state/session-store';
import { AREAS, FRONT_PATH, areaForPath } from './areas';

/** The persistent shell: navigation rail, top bar with the simulation clock, and the active area. */
function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = areaForPath(pathname);
  const stage = useSessionStore((state) => state.stage);

  // The operational screens are shown only to a player in command (ADR 0031). Anyone else is at
  // the front: the menu, a briefing or a summary.
  if (stage !== 'command') return <Navigate to={FRONT_PATH} replace />;

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
  { path: '/menu', element: <MainMenu /> },
  { path: '/new-career', element: <NewCareer /> },
  { path: '/how-to-play', element: <HowToPlay /> },
  { path: '/settings', element: <SettingsFront /> },
  { path: '/brief', element: <DailyBrief /> },
  { path: '/summary', element: <CommandSummary /> },
  {
    element: <Shell />,
    children: [
      { path: '/overview/:eventId?', element: <OverviewScreen /> },
      { path: '/operations', element: <OperationsScreen /> },
      { path: '/fleet/:aircraftId?', element: <FleetScreen /> },
      { path: '/missions/:missionId?/:mode?', element: <MissionsScreen /> },
      { path: '/reports/:section?', element: <ReportsScreen /> },
      { path: '/career', element: <CareerScreen /> },
      { path: '/data', element: <DataScreen /> },
      { path: '/system', element: <SystemScreen /> },
      { path: '*', element: <Navigate to={FRONT_PATH} replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
