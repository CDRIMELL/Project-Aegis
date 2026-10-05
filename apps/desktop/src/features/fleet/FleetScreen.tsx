import { FLIGHT_ASSUMPTIONS, grossMassKg, type RoutePoint } from '@aegis/domain';
import { MAINTENANCE, type AircraftState, type FlightState } from '@aegis/sim';
import {
  Button,
  DataField,
  DataList,
  DataTable,
  EmptyState,
  EntityRow,
  Hint,
  ListPane,
  Meter,
  Notice,
  PageHeader,
  Panel,
  SelectField,
} from '@aegis/ui';
import { MapPin, Plane, Plus, Route, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { CatalogueEntry } from '../../fleet/catalogue';
import { acquireAircraft, setHome, startMaintenance, useCatalogueStore } from '../../fleet/service';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import { focusAircraft } from '../../map/flight-binding';
import { beginPlanning } from '../../state/plan-store';
import { NO_FLIGHTS, useSimStore } from '../../state/sim-store';
import { FuelRequestControl, GroundServiceProgress } from '../shared/GroundService';
import {
  AerodromePicker,
  AircraftStatusBadge,
  SimulatedBadge,
  fuelFraction,
  placeName,
  statusLabel,
} from '../shared/fleet-display';

const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)} h`;

function StatusPanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const flight = useSimStore(
    (state) =>
      state.view?.fleet.activeFlights.find((candidate) => candidate.aircraftId === aircraft.id) ??
      null,
  );
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const [changingHome, setChangingHome] = useState(false);
  const destination = flight?.points.at(-1) ?? null;

  return (
    <Panel
      title="Status"
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={MapPin}
          onClick={() => {
            setChangingHome((open) => !open);
          }}
        >
          Change home
        </Button>
      }
    >
      <DataList>
        <DataField label="State" value={statusLabel(aircraft.status)} prose />
        <DataField label="Location" value={placeName(aircraft.location)} prose />
        <DataField label="Home aerodrome" value={placeName(aircraft.home)} prose />
        <DataField
          label="Current flight"
          value={flight ? `${flight.id} to ${destination?.code ?? destination?.name ?? ''}` : null}
          prose
        />
        <DataField label="Flight phase" value={flight ? flight.phase : null} prose />
        <DataField
          label="Time to arrival"
          value={flight ? formatDuration(Math.max(flight.etaTick - tick, 0)) : null}
        />
      </DataList>
      {changingHome && (
        <div className="mt-3">
          <AerodromePicker
            label="Find a new home aerodrome"
            onPick={(home: RoutePoint) => {
              setHome(aircraft.id, home);
              setChangingHome(false);
            }}
          />
        </div>
      )}
    </Panel>
  );
}

function FuelPanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const model = aircraft.performance;
  if (!model) {
    return (
      <Panel title="Fuel and load">
        <Hint>
          No performance model exists for this type: the reference data lacks{' '}
          {aircraft.performanceMissing.join(', ')}. Fuel and load cannot be modelled.
        </Hint>
      </Panel>
    );
  }
  const mass = grossMassKg(model, aircraft.fuelKg, aircraft.payloadKg);
  return (
    <Panel title="Fuel and load">
      <div className="flex flex-col gap-3">
        <Meter
          label="Fuel"
          value={fuelFraction(aircraft)}
          reading={`${formatInteger(aircraft.fuelKg)} of ${formatKg(model.fuelCapacityKg)}`}
          tone={aircraft.fuelKg < model.reserveFuelKg ? 'warn' : 'info'}
        />
        <Meter
          label="Mass"
          value={mass / model.maxTakeoffMassKg}
          reading={`${formatInteger(mass)} of ${formatKg(model.maxTakeoffMassKg)}`}
          tone="info"
        />
        <DataList>
          <DataField
            label="Payload"
            value={formatKg(aircraft.payloadKg)}
            hint="Total mass carried. Set when a flight is planned."
          />
          <DataField
            label="Reserve (assumed)"
            value={formatKg(model.reserveFuelKg)}
            hint={FLIGHT_ASSUMPTIONS.reserve.statement}
          />
        </DataList>
        {aircraft.status === 'servicing' ? (
          <GroundServiceProgress aircraft={aircraft} columns={2} />
        ) : (
          <FuelRequestControl aircraft={aircraft} />
        )}
        <Hint>
          Fuel quantities are simulated. Capacity is an assumption, not a published figure. Fuel is
          loaded on the ground over simulated time; a flight departs with what is aboard.
        </Hint>
      </div>
    </Panel>
  );
}

function MaintenancePanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const remaining = MAINTENANCE.dueAfterFlightSeconds - aircraft.flightSecondsSinceMaintenance;
  const inMaintenance = aircraft.status === 'in_maintenance';
  return (
    <Panel
      title="Condition and maintenance"
      actions={
        <Button
          size="sm"
          icon={Wrench}
          variant={
            aircraft.status === 'maintenance_due' || aircraft.status === 'unserviceable'
              ? 'primary'
              : 'secondary'
          }
          disabled={
            inMaintenance || aircraft.status === 'in_flight' || aircraft.status === 'servicing'
          }
          title={
            aircraft.status === 'in_flight'
              ? 'The aircraft is airborne.'
              : aircraft.status === 'servicing'
                ? 'The aircraft is being serviced. Maintenance can start when it is available.'
                : `Takes ${formatDuration(MAINTENANCE.durationSeconds)} of simulated time.`
          }
          onClick={() => {
            startMaintenance(aircraft.id);
          }}
        >
          {inMaintenance ? 'In maintenance' : 'Start maintenance'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Meter
          label="Condition"
          value={aircraft.conditionPct / 100}
          reading={`${aircraft.conditionPct.toFixed(1)} %`}
          tone={aircraft.conditionPct < MAINTENANCE.dueBelowConditionPct ? 'warn' : 'ok'}
        />
        <DataList>
          <DataField
            label="Since maintenance"
            value={hours(aircraft.flightSecondsSinceMaintenance)}
          />
          <DataField
            label="Maintenance due in"
            value={remaining > 0 ? hours(remaining) : 'Due'}
            hint={`Due after ${hours(MAINTENANCE.dueAfterFlightSeconds)} of flying or below ${MAINTENANCE.dueBelowConditionPct} % condition. A simulation rule.`}
          />
          <DataField
            label="Returns to service in"
            value={
              inMaintenance && aircraft.maintenanceCompleteTick !== null
                ? formatDuration(Math.max(aircraft.maintenanceCompleteTick - tick, 0))
                : null
            }
          />
        </DataList>
      </div>
    </Panel>
  );
}

function RecordPanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const flights = useSimStore((state) => state.view?.fleet.recentFlights ?? NO_FLIGHTS);
  const own = flights.filter((flight) => flight.aircraftId === aircraft.id).slice(0, 6);
  return (
    <Panel title="Flight record">
      <div className="flex flex-col gap-3">
        <DataList columns={3}>
          <DataField label="Flights" value={formatInteger(aircraft.flights)} />
          <DataField label="Flight time" value={hours(aircraft.flightSecondsTotal)} />
          <DataField label="Acquired at step" value={formatInteger(aircraft.acquiredTick)} />
        </DataList>
        {own.length > 0 ? (
          <DataTable<FlightState>
            caption="Recent flights of this aircraft"
            rows={own}
            rowKey={(flight) => flight.id}
            columns={[
              { header: 'Flight', numeric: true, cell: (flight) => flight.id },
              {
                header: 'Route',
                numeric: true,
                cell: (flight) =>
                  `${flight.plan.points[0]?.code ?? '?'} – ${flight.plan.points.at(-1)?.code ?? '?'}`,
              },
              {
                header: 'Distance',
                numeric: true,
                align: 'right',
                cell: (flight) => formatKm(flight.progress.distanceM),
              },
              {
                header: 'Time',
                numeric: true,
                align: 'right',
                cell: (flight) => formatDuration(flight.progress.elapsedS),
              },
              {
                header: 'Fuel used',
                numeric: true,
                align: 'right',
                cell: (flight) => formatKg(flight.fuelAtDepartureKg - flight.progress.fuelKg),
              },
            ]}
          />
        ) : (
          <Hint>No flights yet.</Hint>
        )}
      </div>
    </Panel>
  );
}

const CALIBRATION_LABEL = {
  ferry_range: 'Ferry range, internal fuel (sourced)',
  ferry_range_assumed_internal: 'Ferry range, internal fuel (assumed)',
  range_with_payload: 'Range at the sourced payload',
  range_at_max_mass: 'Range at maximum mass (assumed)',
} as const;

const FUEL_CAPACITY_LABEL = {
  sourced_mass: 'Fuel capacity',
  sourced_volume: 'Fuel capacity (from volume)',
  assumed: 'Fuel capacity (assumed)',
} as const;

function PerformancePanel({ aircraft }: { readonly aircraft: AircraftState }) {
  const model = aircraft.performance;
  if (!model) return null;
  const assumed = new Set<string>(model.assumptions);
  // A version-1 model has no basis recorded: its capacity was always assumed.
  const fuelBasis = model.fuelCapacityBasis ?? 'assumed';
  return (
    <Panel title="Performance model">
      <div className="flex flex-col gap-3">
        <DataList columns={3}>
          <DataField
            label="Empty mass"
            value={formatKg(model.emptyMassKg)}
            hint="Reference data."
          />
          <DataField
            label="Max take-off mass"
            value={formatKg(model.maxTakeoffMassKg)}
            hint="Reference data."
          />
          <DataField
            label={
              model.referenceRangeKind === 'range' ? 'Published range' : 'Published ferry range'
            }
            value={`${formatInteger(model.referenceRangeKm)} km`}
            hint={`Reference data. The fuel model is calibrated to this figure. ${
              model.referenceConditions
                ? `The source states: ${model.referenceConditions}.`
                : 'The source states no conditions for it.'
            }`}
          />
          <DataField
            label={assumed.has('cruiseSpeed') ? 'Cruise speed (assumed)' : 'Cruise speed'}
            value={`${formatInteger(model.cruiseSpeedKmh)} km/h`}
            hint={
              assumed.has('cruiseSpeed')
                ? FLIGHT_ASSUMPTIONS.cruiseSpeed.statement
                : 'Reference data.'
            }
          />
          <DataField
            label="Service ceiling"
            value={
              model.serviceCeilingM === null ? null : `${formatInteger(model.serviceCeilingM)} m`
            }
            hint="Reference data, where a source gives it."
          />
          <DataField
            label="Cruise altitude (assumed)"
            value={`${formatInteger(model.cruiseAltitudeM)} m`}
            hint={FLIGHT_ASSUMPTIONS.cruiseAltitude.statement}
          />
          <DataField
            label="Calibration"
            value={CALIBRATION_LABEL[model.calibration ?? 'range_at_max_mass']}
            hint={
              assumed.has('rangeCondition')
                ? FLIGHT_ASSUMPTIONS.rangeCondition.statement
                : 'The loading for this figure is stated by the source.'
            }
            prose
          />
          <DataField
            label={FUEL_CAPACITY_LABEL[fuelBasis]}
            value={formatKg(model.fuelCapacityKg)}
            hint={
              fuelBasis === 'sourced_mass'
                ? 'Reference data.'
                : fuelBasis === 'sourced_volume'
                  ? `Reference data, published as a volume. ${FLIGHT_ASSUMPTIONS.fuelDensity.statement}`
                  : FLIGHT_ASSUMPTIONS.fuelCapacity.statement
            }
          />
          <DataField
            label="Climb rate (assumed)"
            value={`${model.climbRateMs} m/s`}
            hint={FLIGHT_ASSUMPTIONS.climbRate.statement}
          />
          <DataField
            label="Range factor (derived)"
            value={`${formatInteger(model.rangeFactorKm)} km`}
            hint="Cruise fuel per kilometre is the aircraft's mass divided by this. Derived from the published range and the fuel capacity."
          />
        </DataList>
        <Hint>
          Values marked assumed or derived are simulation assumptions, not published specifications.
          Flight model version {model.modelVersion}.
        </Hint>
      </div>
    </Panel>
  );
}

function AircraftDetail({ aircraft }: { readonly aircraft: AircraftState }) {
  const navigate = useNavigate();
  const grounded = aircraft.location !== null;
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <PageHeader
        kicker="Aircraft"
        title={aircraft.id}
        subtitle={aircraft.typeName}
        badges={
          <>
            <SimulatedBadge />
            <AircraftStatusBadge status={aircraft.status} />
          </>
        }
        actions={
          <>
            <Button
              icon={MapPin}
              onClick={() => {
                focusAircraft(aircraft.id);
                void navigate('/operations');
              }}
            >
              Show on map
            </Button>
            <Button
              variant="primary"
              icon={Route}
              disabled={!grounded || !aircraft.performance}
              title={
                !aircraft.performance
                  ? 'No performance model exists for this type.'
                  : grounded
                    ? undefined
                    : 'The aircraft is airborne.'
              }
              onClick={() => {
                beginPlanning(aircraft.id);
                focusAircraft(aircraft.id);
                void navigate('/operations');
              }}
            >
              Plan flight
            </Button>
          </>
        }
      />
      {!aircraft.performance && (
        <Notice tone="warn" title="This aircraft cannot fly">
          The reference data lacks {aircraft.performanceMissing.join(', ')} for {aircraft.typeName}.
          AEGIS does not substitute invented values, so no performance model exists for this type
          yet.
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-4">
        <StatusPanel aircraft={aircraft} />
        <FuelPanel aircraft={aircraft} />
        <MaintenancePanel aircraft={aircraft} />
        <RecordPanel aircraft={aircraft} />
      </div>
      <PerformancePanel aircraft={aircraft} />
    </div>
  );
}

function entryLabel(entry: CatalogueEntry): string {
  const service = entry.type.ukServiceName ? ` (${entry.type.ukServiceName})` : '';
  return `${entry.type.name}${service}${entry.performance.available ? '' : ' — cannot fly yet'}`;
}

function AcquirePanel({ onDone }: { readonly onDone: () => void }) {
  const entries = useCatalogueStore((state) => state.entries);
  const error = useCatalogueStore((state) => state.error);
  const [typeId, setTypeId] = useState('');
  const [home, setHomePoint] = useState<RoutePoint | null>(null);
  const entry = entries?.find((candidate) => candidate.type.id === typeId) ?? null;

  if (error) {
    return (
      <Notice tone="critical" title="The aircraft catalogue could not be read">
        {error}
      </Notice>
    );
  }
  if (!entries) return <Hint>Reading the aircraft catalogue.</Hint>;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PageHeader
        kicker="Fleet"
        title="Acquire aircraft"
        subtitle="Creates a simulated aircraft of a real reference type."
      />
      <Panel title="Type">
        <div className="flex flex-col gap-3">
          <SelectField
            label="Reference aircraft type"
            placeholder="Choose a type"
            value={typeId}
            options={entries.map((candidate) => ({
              value: candidate.type.id,
              label: entryLabel(candidate),
            }))}
            onChange={setTypeId}
          />
          {entry?.performance.available && (
            <DataList columns={3}>
              <DataField label="Manufacturer" value={entry.type.manufacturer} prose />
              <DataField
                label="Cruise speed"
                value={`${formatInteger(entry.performance.model.cruiseSpeedKmh)} km/h`}
              />
              <DataField
                label="Published range"
                value={`${formatInteger(entry.performance.model.referenceRangeKm)} km`}
              />
            </DataList>
          )}
          {entry && !entry.performance.available && (
            <Notice tone="warn" title="This type can be acquired but cannot fly yet">
              The reference data lacks {entry.performance.missing.join(', ')}. Nothing is invented
              to fill the gap.
            </Notice>
          )}
        </div>
      </Panel>
      <Panel title="Home aerodrome">
        <div className="flex flex-col gap-3">
          {home && <DataField label="Selected" value={placeName(home)} prose />}
          <AerodromePicker label="Find a home aerodrome" onPick={setHomePoint} />
        </div>
      </Panel>
      <Hint>
        Acquisition has no cost in this phase: AEGIS has no economy yet and does not invent purchase
        prices.
      </Hint>
      <div className="flex gap-2">
        <Button
          variant="primary"
          icon={Plus}
          disabled={!entry || !home}
          onClick={() => {
            if (entry && home) {
              acquireAircraft(entry, home);
              onDone();
            }
          }}
        >
          Acquire
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The fleet: every simulated aircraft, and the full picture of the selected one. */
export function FleetScreen() {
  const aircraft = useSimStore((state) => state.view?.fleet.aircraft ?? null);
  const rejection = useSimStore((state) => state.rejection);
  const starterMissing = useCatalogueStore((state) => state.starterMissing);
  const { aircraftId } = useParams();
  const navigate = useNavigate();
  const acquiring = aircraftId === 'acquire';
  const selected =
    aircraft?.find((candidate) => candidate.id === aircraftId) ?? aircraft?.[0] ?? null;

  return (
    <div className="flex size-full">
      <ListPane
        title={`Fleet (${aircraft?.length ?? 0})`}
        action={
          <Button
            size="sm"
            icon={Plus}
            onClick={() => {
              void navigate('/fleet/acquire');
            }}
          >
            Acquire
          </Button>
        }
      >
        {(aircraft ?? []).map((candidate) => (
          <EntityRow
            key={candidate.id}
            code={candidate.id}
            primary={candidate.typeName}
            secondary={placeName(candidate.location)}
            badge={<AircraftStatusBadge status={candidate.status} />}
            active={!acquiring && candidate.id === selected?.id}
            onSelect={() => {
              void navigate(`/fleet/${candidate.id}`);
            }}
          />
        ))}
      </ListPane>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {rejection && (
            <Notice tone="warn" title="The last command was refused">
              {rejection}
            </Notice>
          )}
          {starterMissing.length > 0 && (
            <Notice tone="warn" title="The starter fleet is incomplete">
              The reference data does not contain {starterMissing.join(', ')}.
            </Notice>
          )}
          {acquiring ? (
            <AcquirePanel
              onDone={() => {
                void navigate('/fleet');
              }}
            />
          ) : selected ? (
            <AircraftDetail aircraft={selected} />
          ) : (
            <EmptyState icon={Plane} title="No aircraft yet">
              The starter fleet is created once reference data is installed. You can also acquire an
              aircraft.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
