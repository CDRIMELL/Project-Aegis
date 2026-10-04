import {
  addMs,
  formatUtc,
  metres,
  metresToFeet,
  kilometresPerHour,
  kilometresPerHourToKnots,
} from '@aegis/domain';
import type { AircraftState, FlightView } from '@aegis/sim';
import { Button, DataField, DataList, DetailPanel, Hint, Meter, SectionLabel } from '@aegis/ui';
import { Route } from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import { formatCoordinates } from '../../map/features';
import { select } from '../../state/map-store';
import { beginPlanning } from '../../state/plan-store';
import { useSimStore } from '../../state/sim-store';
import {
  AircraftStatusBadge,
  SimulatedBadge,
  fuelFraction,
  placeName,
} from '../shared/fleet-display';
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
            hint="The planner's estimate at launch."
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

/** The selected aircraft: live telemetry while it flies, its state and next actions on the ground. */
export function AircraftPanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const flight = useSimStore(
    (state) =>
      state.view?.fleet.activeFlights.find((candidate) => candidate.aircraftId === aircraft.id) ??
      null,
  );
  const navigate = useNavigate();
  const model = aircraft.performance;
  // The accepted or active mission this aircraft is committed to, if any.
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
        <Telemetry flight={flight} />
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
