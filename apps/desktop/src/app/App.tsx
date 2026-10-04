import { AppFrame, NavItem } from '@aegis/ui';
import { SimClockBar } from '../features/sim-clock/SimClockBar';
import { SystemScreen } from '../features/system/SystemScreen';
import { AREAS, type AreaId } from './areas';

// Only one area exists so far. A router is introduced with the second one (phase 3).
const CURRENT_AREA: AreaId = 'system';

export function App() {
  return (
    <AppFrame
      title="System"
      topBar={<SimClockBar />}
      railFooter={`Build ${__APP_VERSION__}`}
      navigation={AREAS.map((area) => (
        <NavItem
          key={area.id}
          icon={area.icon}
          label={area.label}
          active={area.id === CURRENT_AREA}
          {...(area.plannedPhase !== null && {
            unavailableReason: `Not built yet. Planned for phase ${area.plannedPhase}.`,
          })}
        />
      ))}
    >
      <SystemScreen />
    </AppFrame>
  );
}
