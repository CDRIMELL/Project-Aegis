import { addMs, evaluateMission, formatUtc, type Mission, type RoutePoint } from '@aegis/domain';
import { MAINTENANCE_POLICY, type AircraftState } from '@aegis/sim';
import {
  Button,
  ConstraintList,
  DataField,
  DataList,
  DataTable,
  DetailPanel,
  Hint,
  IconButton,
  Notice,
  NumberField,
  SectionLabel,
} from '@aegis/ui';
import { ArrowDown, ArrowUp, Fuel, Plus, Save, Send, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  evaluateDraft,
  generateDraft,
  insertWaypoint,
  isEditablePoint,
  refuelForRoute,
  removeWaypoint,
  setCruiseAltitude,
  setCruiseSpeed,
  setLoad,
  shiftWaypoint,
  type PlanDraft,
} from '../../fleet/plan-edit';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import { formatCoordinates } from '../../map/features';
import { mapController } from '../../map/controller';
import { configurationOf } from '../../missions/mission-logic';
import { updateMission } from '../../missions/service';
import { simClient } from '../../sim/client';
import { select } from '../../state/map-store';
import { cancelPlanning, editDraft, setDraft } from '../../state/plan-store';
import { useSimStore } from '../../state/sim-store';
import {
  AerodromePicker,
  AircraftStatusBadge,
  SimulatedBadge,
  placeName,
} from '../shared/fleet-display';
import { ObjectiveList } from '../shared/mission-display';
import { usePlanContext } from '../shared/usePlanContext';
import { useStable } from '../shared/useStable';

interface RouteRow {
  readonly index: number;
  readonly point: RoutePoint;
  /** Distance of the leg that ends at this point; `null` for the origin. */
  readonly legM: number | null;
}

function RouteTable({ draft, legs }: { draft: PlanDraft; legs: readonly { distanceM: number }[] }) {
  const rows: RouteRow[] = draft.plan.points.map((point, index) => ({
    index,
    point,
    legM: index === 0 ? null : (legs[index - 1]?.distanceM ?? null),
  }));
  const last = rows.length - 1;
  return (
    <DataTable<RouteRow>
      caption="Route points in order"
      rows={rows}
      rowKey={(row) => `${row.index}:${row.point.name}`}
      columns={[
        { header: 'Point', numeric: true, cell: (row) => row.point.code ?? row.point.name },
        {
          header: 'Leg',
          numeric: true,
          align: 'right',
          cell: (row) => (row.legM === null ? '—' : formatKm(row.legM)),
        },
        {
          header: 'Edit',
          align: 'right',
          cell: (row) => (
            <span className="flex justify-end">
              {row.index < last && (
                <IconButton
                  icon={Plus}
                  label={`Add a waypoint after ${row.point.name}`}
                  onClick={() => {
                    editDraft((current) => insertWaypoint(current, row.index));
                  }}
                />
              )}
              {isEditablePoint(draft, row.index) && (
                <>
                  <IconButton
                    icon={ArrowUp}
                    label={`Move ${row.point.name} earlier`}
                    disabled={!isEditablePoint(draft, row.index - 1)}
                    onClick={() => {
                      editDraft((current) => shiftWaypoint(current, row.index, -1));
                    }}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label={`Move ${row.point.name} later`}
                    disabled={!isEditablePoint(draft, row.index + 1)}
                    onClick={() => {
                      editDraft((current) => shiftWaypoint(current, row.index, 1));
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    label={`Remove ${row.point.name}`}
                    onClick={() => {
                      editDraft((current) => removeWaypoint(current, row.index));
                    }}
                  />
                </>
              )}
            </span>
          ),
        },
      ]}
    />
  );
}

/**
 * What the mission's objectives will do if the draft route is flown. The planner's own estimate
 * and constraints are unchanged; this adds the mission's view of the same plan.
 */
function MissionForecast({
  mission,
  aircraft,
  draft,
}: {
  readonly mission: Mission;
  readonly aircraft: AircraftState;
  readonly draft: PlanDraft;
}) {
  const tick = useSimStore((state) => {
    const now = state.view?.clock.tick ?? 0;
    return now - (now % 600);
  });
  const stableMission = useStable(mission);
  const stableAircraft = useStable(aircraft);
  const context = usePlanContext();
  const evaluation = useMemo(
    () =>
      evaluateMission({
        type: stableMission.type,
        aircraft: stableAircraft,
        plan: draft.plan,
        load: draft.load,
        objectives: stableMission.objectives,
        departureTick: tick,
        completeByTick: stableMission.completeByTick,
        maintenance: MAINTENANCE_POLICY,
        stepS: 1,
        weather: context?.weather ?? null,
        ...(context?.hazards && { hazards: context.hazards }),
      }),
    [stableMission, stableAircraft, draft, tick, context],
  );
  const missionOnly = evaluation.constraints.filter(
    (constraint) => !evaluation.plan?.constraints.includes(constraint),
  );
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Mission objectives (forecast)</SectionLabel>
      <ObjectiveList
        objectives={evaluation.forecast?.objectives ?? stableMission.objectives}
        forecast={evaluation.forecast !== null}
      />
      {missionOnly.length > 0 && <ConstraintList items={missionOnly} />}
      <Hint>What each objective will do if this route is flown, launched now.</Hint>
    </section>
  );
}

function DraftEditor({
  aircraft,
  draft,
  mission,
}: {
  aircraft: AircraftState;
  draft: PlanDraft;
  mission: Mission | null;
}) {
  const model = aircraft.performance;
  const navigate = useNavigate();
  const simTime = useSimStore((state) => state.view?.clock.simTime ?? null);
  const context = usePlanContext();
  const evaluation = useMemo(
    () => (model ? evaluateDraft(draft, model, context) : null),
    [draft, model, context],
  );
  if (!model || !evaluation) return null;
  const estimate = evaluation.estimate;

  return (
    <>
      {mission && <MissionForecast mission={mission} aircraft={aircraft} draft={draft} />}
      <section className="flex flex-col gap-2.5">
        <SectionLabel>Estimate</SectionLabel>
        {estimate ? (
          <DataList>
            <DataField label="Distance" value={formatKm(estimate.distanceM)} />
            <DataField label="Flight time" value={formatDuration(estimate.durationS)} />
            <DataField
              label="Arrival (sim, UTC)"
              value={
                simTime === null
                  ? null
                  : formatUtc(addMs(simTime, estimate.durationS * 1000)).slice(11, 19)
              }
              hint="If launched now. Simulated time."
            />
            <DataField
              label="Top altitude"
              value={`${formatInteger(estimate.topAltitudeM)} m`}
              hint="The highest altitude the flight reaches."
            />
            <DataField
              label="Fuel used"
              value={formatKg(estimate.fuelUsedKg)}
              hint="Simulated quantity, from the type's published range and the model's assumptions."
            />
            <DataField
              label="Fuel at destination"
              value={formatKg(estimate.fuelAtDestinationKg)}
              hint={`Assumed reserve: ${formatKg(model.reserveFuelKg)}.`}
            />
            <DataField
              label="Take-off mass"
              value={formatKg(estimate.takeoffMassKg)}
              hint={`Maximum: ${formatKg(model.maxTakeoffMassKg)}.`}
            />
            <DataField label="Reserve (assumed)" value={formatKg(model.reserveFuelKg)} />
          </DataList>
        ) : (
          <Hint>No estimate: the plan cannot be flown as it stands.</Hint>
        )}
      </section>

      {evaluation.constraints.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Constraints</SectionLabel>
          <ConstraintList items={evaluation.constraints} />
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Flight parameters</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Cruise altitude"
            unit="m"
            step={100}
            min={0}
            value={draft.plan.cruiseAltitudeM}
            hint={
              model.serviceCeilingM === null
                ? 'No service ceiling is sourced for this type.'
                : `Service ceiling: ${formatInteger(model.serviceCeilingM)} m.`
            }
            onChange={(value) => {
              editDraft((current) => setCruiseAltitude(current, value));
            }}
          />
          <NumberField
            label="Cruise speed"
            unit="km/h"
            step={10}
            min={0}
            value={draft.plan.cruiseSpeedKmh}
            hint={`Model cruise speed: ${formatInteger(model.cruiseSpeedKmh)} km/h.`}
            onChange={(value) => {
              editDraft((current) => setCruiseSpeed(current, value));
            }}
          />
          <NumberField
            label="Fuel load"
            unit="kg"
            step={100}
            min={0}
            max={model.fuelCapacityKg}
            value={Math.round(draft.load.fuelKg)}
            hint={`Capacity: ${formatKg(model.fuelCapacityKg)}.`}
            onChange={(value) => {
              editDraft((current) => setLoad(current, { fuelKg: value }));
            }}
          />
          <NumberField
            label="Payload"
            unit="kg"
            step={500}
            min={0}
            max={model.maxPayloadKg}
            value={Math.round(draft.load.payloadKg)}
            hint="Total mass carried. No particular cargo is modelled."
            onChange={(value) => {
              editDraft((current) => setLoad(current, { payloadKg: value }));
            }}
          />
        </div>
        <div>
          <Button
            size="sm"
            icon={Fuel}
            onClick={() => {
              editDraft((current) => refuelForRoute(current, model, context));
            }}
          >
            Fuel for this route
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Route</SectionLabel>
        <RouteTable draft={draft} legs={estimate?.legs ?? []} />
        <Hint>
          On the map: drag a waypoint to move it, press the small handle on a leg to add one,
          right-click a waypoint to remove it.
        </Hint>
      </section>

      <div className="flex gap-2">
        {mission && (
          <Button
            variant="primary"
            icon={Save}
            onClick={() => {
              // The route becomes part of the mission; it is launched from the mission.
              updateMission(mission, {
                ...configurationOf(mission),
                plan: draft.plan,
                load: draft.load,
              });
              cancelPlanning();
              void navigate(`/missions/${mission.id}`);
            }}
          >
            Save route to mission
          </Button>
        )}
        {mission && (
          <Button
            variant="ghost"
            onClick={() => {
              cancelPlanning();
              void navigate(`/missions/${mission.id}`);
            }}
          >
            Discard changes
          </Button>
        )}
        {!mission && (
          <Button
            variant="primary"
            icon={Send}
            disabled={!evaluation.flyable}
            title={evaluation.flyable ? undefined : 'Resolve the blocking constraints first.'}
            onClick={() => {
              simClient.send({
                type: 'launchFlight',
                aircraftId: aircraft.id,
                plan: draft.plan,
                load: draft.load,
              });
              cancelPlanning();
              select({ type: 'aircraft', id: aircraft.id });
            }}
          >
            Launch
          </Button>
        )}
        {!mission && (
          <Button variant="ghost" onClick={cancelPlanning}>
            Discard plan
          </Button>
        )}
      </div>
    </>
  );
}

/** Plans a flight for one aircraft: choose a destination, review and edit the plan, launch. */
export function FlightPlannerPanel({
  aircraft,
  draft,
  mission = null,
}: {
  readonly aircraft: AircraftState;
  readonly draft: PlanDraft | null;
  /** The mission whose route is being edited; `null` when planning a flight on its own. */
  readonly mission?: Mission | null;
}) {
  const origin = aircraft.location;
  const model = aircraft.performance;
  const context = usePlanContext();
  const destination = draft?.plan.points.at(-1) ?? null;

  const choose = (point: RoutePoint) => {
    if (!origin || !model) return;
    setDraft(generateDraft(aircraft.id, model, origin, point, aircraft.payloadKg, context));
    mapController().fitBounds(
      Math.min(origin.lon, point.lon),
      Math.min(origin.lat, point.lat),
      Math.max(origin.lon, point.lon),
      Math.max(origin.lat, point.lat),
    );
  };

  return (
    <DetailPanel
      kicker={mission ? `Route of ${mission.id}` : 'Flight plan'}
      title={aircraft.id}
      badges={
        <>
          <SimulatedBadge />
          <AircraftStatusBadge status={aircraft.status} />
        </>
      }
      onClose={cancelPlanning}
    >
      <section className="flex flex-col gap-2.5">
        <SectionLabel>Aircraft</SectionLabel>
        <DataList columns={1}>
          <DataField label="Type" value={aircraft.typeName} prose />
          <DataField label="Origin" value={placeName(origin)} prose />
          {origin && (
            <DataField label="Position" value={formatCoordinates(origin.lat, origin.lon)} />
          )}
        </DataList>
      </section>

      {!model && (
        <Notice tone="warn" title="This aircraft cannot be planned">
          The reference data lacks {aircraft.performanceMissing.join(', ')} for this type, so no
          performance model exists for it.
        </Notice>
      )}
      {model && aircraft.status !== 'available' && (
        <Notice tone="warn" title="This aircraft cannot launch at the moment">
          A plan can be drafted, but it will be refused until the aircraft is available.
        </Notice>
      )}

      {mission && (
        <Hint>
          Editing the route of {mission.title}. Where the mission goes is set in the mission; here
          you shape how it gets there.
        </Hint>
      )}

      {model && origin && !mission && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Destination</SectionLabel>
          {destination && <DataField label="Selected" value={placeName(destination)} prose />}
          <AerodromePicker label="Find a destination aerodrome" onPick={choose} />
          {!draft && <Hint>Choose a destination to generate a flight plan.</Hint>}
        </section>
      )}

      {draft && <DraftEditor aircraft={aircraft} draft={draft} mission={mission} />}
    </DetailPanel>
  );
}
