import type { Mission } from '@aegis/domain';
import { Button, DataField, DataList, DetailPanel, Hint, Meter, SectionLabel } from '@aegis/ui';
import { ClipboardList, Plane } from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatDuration, formatKg, formatKm } from '../../format';
import { missionProgress, routeSummary } from '../../missions/mission-logic';
import { select } from '../../state/map-store';
import { useSimStore } from '../../state/sim-store';
import {
  MissionStatusBadge,
  ObjectiveList,
  PriorityBadge,
  SourceBadge,
  formatTick,
  relativeTick,
  typeLabel,
} from '../shared/mission-display';

/** A mission beside the map: where it stands and how its objectives are going. */
export function MissionPanel({ mission }: { readonly mission: Mission }) {
  const navigate = useNavigate();
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const flight = useSimStore(
    (state) =>
      state.view?.fleet.activeFlights.find((candidate) => candidate.id === mission.flightId) ??
      null,
  );
  const required = mission.objectives.filter((objective) => objective.required);

  return (
    <DetailPanel
      kicker={`${typeLabel(mission)} mission`}
      title={mission.id}
      badges={
        <>
          <SourceBadge mission={mission} />
          <MissionStatusBadge status={mission.status} />
          <PriorityBadge priority={mission.priority} />
        </>
      }
      onClose={() => {
        select(null);
      }}
    >
      <section className="flex flex-col gap-2.5">
        <SectionLabel>{mission.title}</SectionLabel>
        <DataList columns={1}>
          <DataField label="Route" value={routeSummary(mission)} prose />
          <DataField label="Aircraft" value={mission.aircraftId} />
          <DataField
            label="Complete by (sim, UTC)"
            value={
              mission.completeByTick === null
                ? null
                : `${formatTick(epoch, mission.completeByTick) ?? ''} (${relativeTick(tick, mission.completeByTick) ?? ''})`
            }
          />
        </DataList>
      </section>

      {mission.status === 'active' && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Progress</SectionLabel>
          <Meter
            label="Required objectives"
            value={missionProgress(mission)}
            reading={`${required.filter((o) => o.status === 'complete').length} of ${required.length} complete`}
            tone="ok"
          />
          {flight && (
            <DataList>
              <DataField
                label="Distance to go"
                value={formatKm(flight.totalM - flight.distanceM)}
              />
              <DataField
                label="Time to go"
                value={formatDuration(Math.max(flight.etaTick - tick, 0))}
              />
              <DataField label="Fuel" value={formatKg(flight.fuelKg)} />
              <DataField label="Phase" value={flight.phase} prose />
            </DataList>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Objectives</SectionLabel>
        <ObjectiveList objectives={mission.objectives} />
      </section>

      {mission.outcome && <Hint>{mission.outcome.summary}</Hint>}

      <div className="flex flex-wrap gap-2">
        <Button
          icon={ClipboardList}
          onClick={() => {
            void navigate(`/missions/${mission.id}`);
          }}
        >
          Open mission
        </Button>
        {mission.aircraftId && (
          <Button
            variant="ghost"
            icon={Plane}
            onClick={() => {
              if (mission.aircraftId) select({ type: 'aircraft', id: mission.aircraftId });
            }}
          >
            Aircraft telemetry
          </Button>
        )}
      </div>
    </DetailPanel>
  );
}
