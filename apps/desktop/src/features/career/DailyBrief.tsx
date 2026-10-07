import { Button, DataList, Notice, Panel, StatTile, StatusBadge } from '@aegis/ui';
import { useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { dailyBrief } from '../../career/brief-logic';
import { takeCommand } from '../../career/service';
import { useSimStore } from '../../state/sim-store';
import { BriefItems, FrontFrame, FrontTitle, Kicker } from './parts';

/**
 * The Daily Operational Brief (ADR 0031): the world at the moment command is taken or resumed.
 * It is read from the simulation's published state; nothing on it is written here.
 */
export function DailyBrief() {
  const navigate = useNavigate();
  const view = useSimStore((state) => state.view);
  const brief = useMemo(() => (view ? dailyBrief(view) : null), [view]);
  if (!view || !brief) return <Navigate to="/menu" replace />;

  const { air } = brief;
  const readiness = air.owned > 0 ? Math.round((air.ready / air.owned) * 100) : null;
  const established = view.career.establishedTick !== null;

  return (
    <FrontFrame wide>
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Kicker>
              {brief.resuming ? 'Operational brief · resuming' : 'Daily operational brief'}
            </Kicker>
            <FrontTitle>
              <span className="telemetry">{brief.time}</span> — {brief.weekday}
            </FrontTitle>
            <p className="mt-1 text-sm text-ink-muted">
              <span className="telemetry">{brief.date}</span> UTC, simulation time
              {brief.day !== null && ` · Command day ${brief.day}`}
            </p>
          </div>
          <StatusBadge tone="ok">Simulated</StatusBadge>
        </div>

        {!established && (
          <Notice tone="info" title="This world was begun before careers">
            Taking command begins your record at this moment. From then on the world operates by
            itself: routine sorties are tasked and flown without you, and a reserve of each kind of
            aircraft is kept back for you to use.
          </Notice>
        )}

        <Panel title="UK air operations">
          <DataList columns={4}>
            <StatTile
              label="Operational readiness"
              value={readiness === null ? null : String(readiness)}
              unit="%"
              detail={`${air.ready} of ${air.owned} aircraft available or flying`}
              hint="The share of aircraft that are available or flying. Aircraft being prepared, turned round or maintained are not counted as ready."
            />
            <StatTile
              label="Airborne"
              value={String(air.airborne)}
              detail={`${air.activeMissions} mission${air.activeMissions === 1 ? '' : 's'} under way`}
            />
            <StatTile
              label="Available"
              value={String(air.available)}
              detail={`${air.servicing} being prepared or turned round`}
            />
            <StatTile
              label="Unavailable"
              value={String(air.unavailable)}
              detail="Due maintenance, in maintenance or unserviceable"
            />
            <StatTile
              label="Weather"
              value={air.weather}
              detail={
                air.weatherAt ? `Worst at ${air.weatherAt}` : 'At every aerodrome the fleet is at'
              }
              hint="Simulated weather, at the aerodromes aircraft are at now."
            />
            <StatTile
              label="Events in the area"
              value={String(air.eventsActive)}
              detail={`In effect now. ${air.eventsAnnounced} more announced`}
              hint="Simulated events in the operating area: closures, disruptions and severe weather."
            />
            <StatTile
              label="Overseas commitments"
              value={String(air.overseas)}
              detail="Missions accepted or flying to an aerodrome outside the UK"
            />
            <StatTile
              label="Routine tasking"
              value={String(air.routineMissions)}
              detail={
                view.missions.routineEnabled
                  ? 'Missions in the air that the world tasked itself'
                  : 'Begins when you take command'
              }
            />
          </DataList>
        </Panel>

        <div className="grid grid-cols-2 gap-5">
          <Panel title="Priorities">
            <BriefItems items={brief.priorities} empty="Nothing is waiting for your decision." />
          </Panel>
          <Panel title="Watch items">
            <BriefItems items={brief.watch} empty="Nothing in particular to watch." />
          </Panel>
        </div>

        <Panel title="Command note">
          <p className="text-lg leading-relaxed text-ink">{brief.note}</p>
        </Panel>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => {
              takeCommand();
              void navigate('/operations');
            }}
          >
            {brief.resuming ? 'Resume command' : 'Take command'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void navigate('/menu');
            }}
          >
            Back to the menu
          </Button>
          <span className="text-sm text-ink-muted">
            The clock starts when you do. It is continuous: pause it or speed it up at any time.
          </span>
        </div>
      </div>
    </FrontFrame>
  );
}
