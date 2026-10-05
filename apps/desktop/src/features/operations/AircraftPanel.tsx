import {
  addMs,
  formatUtc,
  metres,
  metresToFeet,
  kilometresPerHour,
  kilometresPerHourToKnots,
} from '@aegis/domain';
import type { AircraftState, FlightView } from '@aegis/sim';
import {
  Button,
  DataField,
  DataList,
  DetailPanel,
  Hint,
  Meter,
  Notice,
  SectionLabel,
} from '@aegis/ui';
import { Route } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import { formatCoordinates } from '../../map/features';
import {
  advisoriesFor,
  currentEstimate,
  operationsFor,
  remainderOf,
  revisionDraft,
  type Operation,
} from '../../operations/inflight-logic';
import { simClient } from '../../sim/client';
import { select } from '../../state/map-store';
import { beginPlanning, beginRevision } from '../../state/plan-store';
import { useSimStore } from '../../state/sim-store';
import {
  AircraftStatusBadge,
  SimulatedBadge,
  fuelFraction,
  placeName,
} from '../shared/fleet-display';
import { usePlanContext } from '../shared/usePlanContext';
import { formatPrecipitation, formatWind } from '../shared/weather-display';

const PHASE = {
  takeoff: 'Take-off',
  climb: 'Climb',
  cruise: 'Cruise',
  descent: 'Descent',
  landed: 'Landed',
} as const;

function Telemetry({ flight }: { readonly flight: FlightView }) {
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const destination = flight.points.at(-1) ?? null;
  const remainingS = Math.max(flight.etaTick - tick, 0);
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <SectionLabel>Flight {flight.id}</SectionLabel>
        <Meter
          label={`${flight.points[0]?.code ?? 'Origin'} to ${destination?.code ?? 'destination'}`}
          value={flight.totalM > 0 ? flight.distanceM / flight.totalM : 0}
          reading={`${formatKm(flight.totalM - flight.distanceM)} to go`}
          tone="ok"
        />
        <DataList>
          <DataField label="Phase" value={PHASE[flight.phase]} prose />
          <DataField label="Destination" value={placeName(destination)} prose />
          <DataField
            label="Arrival (sim, UTC)"
            value={
              epoch === null ? null : formatUtc(addMs(epoch, flight.etaTick * 1000)).slice(11, 19)
            }
          />
          <DataField label="Time to go" value={formatDuration(remainingS)} />
        </DataList>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Telemetry (simulated)</SectionLabel>
        <DataList>
          <DataField
            label="Altitude"
            value={`${formatInteger(flight.altitudeM)} m`}
            hint={`${formatInteger(metresToFeet(metres(flight.altitudeM)))} ft`}
          />
          <DataField
            label="Speed"
            value={`${formatInteger(flight.speedKmh)} km/h`}
            hint={`${formatInteger(kilometresPerHourToKnots(kilometresPerHour(flight.speedKmh)))} kn true airspeed`}
          />
          <DataField
            label="Heading"
            value={`${String(Math.round(flight.headingDeg) % 360).padStart(3, '0')}°`}
          />
          <DataField label="Distance flown" value={formatKm(flight.distanceM)} />
          <DataField label="Fuel" value={formatKg(flight.fuelKg)} />
          <DataField label="Fuel flow" value={`${formatInteger(flight.burnRateKgH)} kg/h`} />
          <DataField
            label="Fuel at destination"
            value={formatKg(flight.estimatedFuelAtDestinationKg)}
            hint="Projected from the flight's own state when it launched, changed route or stopped holding."
          />
          <DataField label="Elapsed" value={formatDuration(flight.elapsedS)} />
        </DataList>
        <DataList columns={1}>
          <DataField label="Position" value={formatCoordinates(flight.lat, flight.lon)} />
        </DataList>
      </section>
      <section className="flex flex-col gap-2.5">
        <SectionLabel>Conditions (simulated)</SectionLabel>
        <DataList>
          <DataField
            label="Ground speed"
            value={`${formatInteger(flight.groundSpeedKmh)} km/h`}
            hint="Airspeed, less what a crosswind takes, plus the wind along the track."
          />
          <DataField
            label={flight.tailwindKmh >= 0 ? 'Tailwind' : 'Headwind'}
            value={`${formatInteger(Math.abs(flight.tailwindKmh))} km/h`}
            hint="Sampled once a minute and held in between."
          />
          <DataField label="Wind" value={formatWind(flight)} />
          <DataField label="Outside air" value={`${flight.outsideTemperatureC.toFixed(0)} °C`} />
          <DataField label="Visibility" value={`${flight.visibilityKm.toFixed(0)} km`} />
          <DataField
            label="Precipitation"
            value={formatPrecipitation(flight.precipitation)}
            prose
          />
        </DataList>
      </section>
    </>
  );
}

const INTENT_WORD = {
  reroute: 'Rerouted',
  divert: 'Diverting',
  return: 'Returning to base',
} as const;

/**
 * What the operator can do with the flight now (ADR 0026), and what they should know first.
 * Every action that applies is shown; one that cannot be taken says why.
 */
function Operations({
  aircraft,
  flight,
}: {
  readonly aircraft: AircraftState;
  readonly flight: FlightView;
}) {
  const mission = useSimStore(
    (state) =>
      state.view?.missions.missions.find(
        (candidate) => candidate.id === flight.missionId && candidate.status === 'active',
      ) ?? null,
  );
  const context = usePlanContext();
  const model = aircraft.performance;
  // A projection flies the rest of the route, so it is made once a minute of simulation time,
  // and at once when the route or the hold changes.
  const bucket = useSimStore((state) => Math.floor((state.view?.clock.tick ?? 0) / 60));
  const key = `${bucket}:${flight.revisions.length}:${flight.hold ?? ''}:${flight.closureLanding}`;
  const advisories = useMemo(
    () =>
      model && context
        ? advisoriesFor(flight, model, currentEstimate(model, flight, context).projection)
        : [],
    // The flight changes ten times a second; the key says when it is worth looking again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, model, context],
  );
  const operations = operationsFor(flight, aircraft, mission);
  const origin = flight.points[0];

  const act = (operation: Operation) => {
    switch (operation) {
      case 'hold':
        simClient.send({ type: 'holdFlight', aircraftId: aircraft.id });
        break;
      case 'resume':
        simClient.send({ type: 'resumeFlight', aircraftId: aircraft.id });
        break;
      case 'reroute':
      case 'divert':
        beginRevision(revisionDraft(flight, remainderOf(flight)), {
          intent: operation,
          abortMissionId: null,
          abortContinue: false,
        });
        break;
      case 'return':
        if (origin) {
          beginRevision(revisionDraft(flight, [origin]), {
            intent: 'return',
            abortMissionId: null,
            abortContinue: false,
          });
        }
        break;
      case 'abort':
        if (mission) {
          // The landing is the operator's to choose; it opens on "go on", which changes no route.
          beginRevision(revisionDraft(flight, remainderOf(flight)), {
            intent: 'divert',
            abortMissionId: mission.id,
            abortContinue: true,
          });
        }
        break;
    }
  };

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Operations</SectionLabel>
      {advisories.map((advisory) => (
        <Notice key={advisory.title} tone={advisory.tone} title={advisory.title}>
          {advisory.detail}
        </Notice>
      ))}
      {(flight.intent !== null || flight.hold !== null) && (
        <DataList columns={1}>
          {flight.intent !== null && (
            <DataField
              label="Route"
              value={`${INTENT_WORD[flight.intent]} · launched for ${placeName(flight.plannedDestination)}`}
              hint={`${flight.revisions.length} change${flight.revisions.length === 1 ? '' : 's'} of route since launch.`}
              prose
            />
          )}
          {flight.hold !== null && (
            <DataField
              label="Holding"
              value={`${formatDuration(flight.heldS)} so far`}
              hint="Circling where it is, burning fuel at the holding assumption."
            />
          )}
        </DataList>
      )}
      <div className="flex flex-wrap gap-2">
        {operations.map((operation) => (
          <Button
            key={operation.operation}
            size="sm"
            disabled={!operation.available}
            title={operation.reason ?? undefined}
            onClick={() => {
              act(operation.operation);
            }}
          >
            {operation.label}
          </Button>
        ))}
      </div>
      {operations
        .filter((operation) => !operation.available)
        .map((operation) => (
          <Hint key={operation.operation}>
            {operation.label}: {operation.reason}
          </Hint>
        ))}
    </section>
  );
}

/** The selected aircraft: live telemetry while it flies, its state and next actions on the ground. */
export function AircraftPanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const flight = useSimStore(
    (state) =>
      state.view?.fleet.activeFlights.find((candidate) => candidate.aircraftId === aircraft.id) ??
      null,
  );
  const navigate = useNavigate();
  const model = aircraft.performance;
  // The accepted or active mission this aircraft is committed to, if any. An aborted mission's
  // aircraft flies on, committed to nothing.
  const mission = useSimStore(
    (state) =>
      state.view?.missions.missions.find(
        (candidate) =>
          candidate.aircraftId === aircraft.id &&
          (candidate.status === 'accepted' || candidate.status === 'active'),
      ) ?? null,
  );

  return (
    <DetailPanel
      kicker={aircraft.typeName}
      title={aircraft.id}
      badges={
        <>
          <SimulatedBadge />
          <AircraftStatusBadge status={aircraft.status} />
        </>
      }
      onClose={() => {
        select(null);
      }}
    >
      {flight ? (
        <>
          <Operations aircraft={aircraft} flight={flight} />
          <Telemetry flight={flight} />
        </>
      ) : (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>On the ground</SectionLabel>
          <DataList columns={1}>
            <DataField label="Location" value={placeName(aircraft.location)} prose />
            <DataField label="Home" value={placeName(aircraft.home)} prose />
          </DataList>
          {model ? (
            <Meter
              label="Fuel"
              value={fuelFraction(aircraft)}
              reading={`${formatInteger(aircraft.fuelKg)} of ${formatKg(model.fuelCapacityKg)}`}
              tone={aircraft.fuelKg < model.reserveFuelKg ? 'warn' : 'info'}
            />
          ) : (
            <Hint>
              No performance model: the reference data lacks{' '}
              {aircraft.performanceMissing.join(', ')}.
            </Hint>
          )}
          <Meter
            label="Condition"
            value={aircraft.conditionPct / 100}
            reading={`${aircraft.conditionPct.toFixed(1)} %`}
            tone={aircraft.conditionPct < 60 ? 'warn' : 'ok'}
          />
        </section>
      )}

      {mission && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Mission</SectionLabel>
          <DataList columns={1}>
            <DataField label={mission.id} value={mission.title} prose />
          </DataList>
          <div>
            <Button
              size="sm"
              onClick={() => {
                select({ type: 'mission', id: mission.id });
              }}
            >
              Show mission
            </Button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        {!flight && (
          <Button
            variant="primary"
            icon={Route}
            disabled={!model || mission !== null}
            title={
              mission
                ? `Committed to ${mission.id}. Launch the mission, or release it first.`
                : undefined
            }
            onClick={() => {
              beginPlanning(aircraft.id);
            }}
          >
            Plan flight
          </Button>
        )}
        <Button
          onClick={() => {
            void navigate(`/fleet/${aircraft.id}`);
          }}
        >
          Open in Fleet
        </Button>
      </div>
    </DetailPanel>
  );
}
