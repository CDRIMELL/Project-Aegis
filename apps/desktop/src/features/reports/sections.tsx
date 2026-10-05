import {
  EVENT_LABEL,
  MISSION_TEMPLATES,
  OUTLOOK_GROUPS,
  filterAircraft,
  filterEvents,
  filterFlights,
  filterMaintenance,
  filterMissions,
  filterOutlook,
  severityWord,
  type AircraftUtilisation,
  type EventRecord,
  type EventTypeCount,
  type FlightRecord,
  type MaintenanceOutlookRow,
  type MaintenanceVisit,
  type MissionRecord,
  type OutlookGroup,
} from '@aegis/domain';
import {
  Chart,
  DataList,
  DataTable,
  EmptyState,
  Hint,
  Panel,
  StatTile,
  StatusBadge,
  type ChartSeries,
  type StatusTone,
} from '@aegis/ui';
import { CalendarClock, CloudSun, Fuel, Plane, Route, Wrench } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import {
  againstEstimate,
  changeText,
  currentPicture,
  percentText,
  reportSeries,
  sortRows,
  type SortValue,
} from '../../reports/report-logic';
import { setReportFilter, useReportStore } from '../../state/report-store';
import { useSimStore } from '../../state/sim-store';
import { AircraftStatusBadge } from '../shared/fleet-display';
import { MissionStatusBadge } from '../shared/mission-display';
import { EventStatusBadge } from '../shared/weather-display';
import {
  AircraftLink,
  EventLink,
  FilterBar,
  FilterCount,
  MissionLink,
  TwoLine,
  useSort,
  when,
  type SectionProps,
} from './parts';

const hours = (seconds: number, places = 1) => (seconds / 3600).toFixed(places);
const one = (value: number) => value.toFixed(1);
const SIM_METRIC = 'An AEGIS simulation metric. It is not a measure of real-world readiness.';

/* -------------------------------------------------------------------------- Summary */

/** The world at this instant, from the live simulation, not from the report. */
function NowPanel() {
  const view = useSimStore((state) => state.view);
  if (!view) return null;
  const now = currentPicture(view);
  return (
    <Panel title="Now">
      <DataList columns={4}>
        <StatTile
          label="Aircraft available"
          value={formatInteger(now.available)}
          detail={`of ${formatInteger(now.aircraft)} in the fleet`}
        />
        <StatTile label="Airborne" value={formatInteger(now.airborne)} />
        <StatTile
          label="Unavailable"
          value={formatInteger(now.unavailable)}
          detail={`${formatInteger(now.inMaintenance)} in maintenance`}
          hint="Due maintenance, in maintenance or unserviceable."
        />
        <StatTile
          label="Awaiting maintenance"
          value={formatInteger(now.awaitingMaintenance)}
          hint="Due maintenance or unserviceable, and not yet being maintained."
        />
        <StatTile label="Active missions" value={formatInteger(now.activeMissions)} />
        <StatTile
          label="Pending missions"
          value={formatInteger(now.pendingMissions)}
          hint="Planned or accepted, and not yet launched."
        />
        <StatTile label="Open offers" value={formatInteger(now.openOffers)} />
        <StatTile
          label="Active events"
          value={formatInteger(now.activeEvents)}
          detail={`${formatInteger(now.announcedEvents)} announced`}
        />
      </DataList>
    </Panel>
  );
}

export function SummarySection({ report, previous }: SectionProps) {
  const { totals, fleet } = report;
  const before = previous?.totals ?? null;
  const series = useMemo(() => reportSeries(report), [report]);
  const approaching = report.outlook.filter((row) => row.group !== 'healthy').length;
  const serviceable = report.outlook.filter(
    (row) => row.group === 'healthy' || row.group === 'approaching',
  ).length;
  const estimate = againstEstimate(totals.fuelUsedKg, totals.estimatedFuelUsedKg);

  return (
    <>
      <NowPanel />
      <Panel title="In the period">
        <DataList columns={4}>
          <StatTile
            label="Missions completed"
            value={formatInteger(totals.missionsCompleted)}
            detail={changeText(totals.missionsCompleted, before?.missionsCompleted ?? null)}
          />
          <StatTile
            label="Missions failed"
            value={formatInteger(totals.missionsFailed)}
            detail={changeText(totals.missionsFailed, before?.missionsFailed ?? null)}
          />
          <StatTile
            label="Missions cancelled"
            value={formatInteger(totals.missionsCancelled)}
            detail={`${formatInteger(totals.offersLapsed)} offers expired or rejected`}
          />
          <StatTile
            label="Flights"
            value={formatInteger(totals.flights)}
            detail={changeText(totals.flights, before?.flights ?? null)}
          />
          <StatTile
            label="Flight time"
            value={hours(totals.flightSeconds)}
            unit="h"
            detail={changeText(
              totals.flightSeconds / 3600,
              before ? before.flightSeconds / 3600 : null,
              (value) => `${one(value)} h`,
            )}
          />
          <StatTile
            label="Distance flown"
            value={formatInteger(totals.distanceM / 1000)}
            unit="km"
            detail={changeText(
              totals.distanceM / 1000,
              before ? before.distanceM / 1000 : null,
              (value) => `${formatInteger(value)} km`,
            )}
          />
          <StatTile
            label="Fuel used"
            value={formatInteger(totals.fuelUsedKg)}
            unit="kg"
            detail={changeText(totals.fuelUsedKg, before?.fuelUsedKg ?? null, formatKg)}
          />
          <StatTile
            label="Against the estimate"
            value={estimate}
            detail="Fuel used against the estimates made at launch"
          />
        </DataList>
        <div className="mt-3">
          <Hint>
            A flight or a mission is counted in the period in which it finished, with the figures
            recorded when it did. What is still under way is counted in no total.
          </Hint>
        </div>
      </Panel>

      <Panel title="Fleet indicators · AEGIS simulation metrics">
        <DataList columns={4}>
          <StatTile
            label="Availability"
            value={percentText(fleet.availability)}
            unit="%"
            detail="Time not due, in maintenance or unserviceable"
            hint={SIM_METRIC}
          />
          <StatTile
            label="Utilisation"
            value={percentText(fleet.utilisation)}
            unit="%"
            detail="Time airborne"
            hint={SIM_METRIC}
          />
          <StatTile
            label="Aircraft flown"
            value={formatInteger(fleet.aircraftFlown)}
            detail={`of ${formatInteger(fleet.aircraft)} flew in the period`}
          />
          <StatTile
            label="Serviceable now"
            value={formatInteger(serviceable)}
            detail={`${formatInteger(approaching)} need attention or are near it`}
          />
        </DataList>
        <div className="mt-3">
          <Hint>
            Both rates are shares of the time each aircraft was owned in the period, taken from the
            log of what it did. They describe this simulated fleet and nothing else.
            {fleet.notRecordedS > 0 &&
              ` ${hours(fleet.notRecordedS)} aircraft-hours in the period have no recorded status and are left out.`}
          </Hint>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel title={`Flight time per ${series.hourly ? 'hour' : 'simulated day'}`}>
          <Chart
            label="Flight time over the period"
            kind="bar"
            categories={series.categories}
            series={series.flightHours}
            unit="h"
            empty="No flight finished in this period."
          />
        </Panel>
        <Panel title={`Missions ended per ${series.hourly ? 'hour' : 'simulated day'}`}>
          <Chart
            label="Missions completed and failed over the period"
            kind="bar"
            stacked
            categories={series.categories}
            series={series.outcomes}
            empty="No mission was completed or failed in this period."
          />
        </Panel>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- Missions */

const MISSION_SORT: Readonly<Record<string, (mission: MissionRecord) => SortValue>> = {
  mission: (mission) => mission.id,
  outcome: (mission) => mission.status,
  aircraft: (mission) => mission.aircraftId,
  ended: (mission) => mission.completedTick,
  risk: (mission) => mission.launchRisk,
};

function riskCell(mission: MissionRecord) {
  if (mission.launchRisk === null && mission.acceptanceRisk === null) {
    return <span className="text-ink-disabled">—</span>;
  }
  return (
    <TwoLine
      top={mission.launchRisk === null ? 'Not launched' : `${one(mission.launchRisk)} at launch`}
      bottom={
        mission.acceptanceRisk === null
          ? 'Acceptance not recorded'
          : `${one(mission.acceptanceRisk)} as accepted`
      }
    />
  );
}

export function MissionsSection({ report }: SectionProps) {
  const filter = useReportStore((state) => state.filter);
  const { sort, onSort } = useSort('missions');
  const flights = useMemo(
    () => new Map(report.flights.map((flight) => [flight.id, flight])),
    [report],
  );
  const flightOf = (mission: MissionRecord) =>
    mission.flightId ? flights.get(mission.flightId) : undefined;
  const rows = sortRows(
    filterMissions(report, filter),
    {
      ...MISSION_SORT,
      flight: (mission) => flightOf(mission)?.durationS ?? null,
      fuel: (mission) => flightOf(mission)?.fuelUsedKg ?? null,
    },
    sort,
  );

  const chart = useMemo(() => {
    const series = (
      name: string,
      tone: ChartSeries['tone'],
      key: 'completed' | 'failed' | 'cancelled' | 'lapsed',
    ): ChartSeries => ({ name, tone, values: report.missionTypes.map((type) => type[key]) });
    return {
      types: report.missionTypes.map((type) => type.type),
      categories: report.missionTypes.map((type) => MISSION_TEMPLATES[type.type].label),
      series: [
        series('Completed', 'accent', 'completed'),
        series('Failed', 'critical', 'failed'),
        series('Cancelled', 'warn', 'cancelled'),
        series('Expired or rejected', 'neutral', 'lapsed'),
      ],
    };
  }, [report]);

  if (report.missions.length === 0) {
    return (
      <Panel title="Missions ended in the period">
        <EmptyState icon={Route} title="No mission ended in this period">
          A mission is reported in the period in which it was completed, failed, cancelled or
          lapsed. Choose a longer period, or fly one.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <>
      <Panel title="Outcomes by mission type">
        <Chart
          label="Mission outcomes by type"
          kind="bar"
          stacked
          horizontal
          height={Math.max(120, 44 + chart.categories.length * 30)}
          categories={chart.categories}
          series={chart.series}
          unit="missions"
          onSelect={(index) => {
            setReportFilter({ missionType: chart.types[index] ?? null });
          }}
        />
        <div className="mt-2">
          <Hint>Select a bar to list only that type.</Hint>
        </div>
      </Panel>
      <Panel title="Missions ended in the period">
        <div className="flex flex-col gap-3">
          <FilterBar report={report} show={['missionType', 'missionStatus', 'aircraftId']} />
          <FilterCount shown={rows.length} of={report.missions.length} what="missions" />
          <div className="overflow-x-auto">
            <DataTable<MissionRecord>
              caption="Missions that ended in the period"
              rows={rows}
              rowKey={(mission) => mission.id}
              {...(sort && { sort })}
              onSort={onSort}
              columns={[
                {
                  header: 'Mission',
                  sortKey: 'mission',
                  cell: (mission) => (
                    <TwoLine
                      top={<MissionLink id={mission.id} />}
                      bottom={MISSION_TEMPLATES[mission.type].label}
                    />
                  ),
                },
                {
                  header: 'Outcome',
                  sortKey: 'outcome',
                  cell: (mission) => <MissionStatusBadge status={mission.status} />,
                },
                {
                  header: 'Aircraft',
                  sortKey: 'aircraft',
                  cell: (mission) => <AircraftLink id={mission.aircraftId} />,
                },
                {
                  header: 'Ended',
                  sortKey: 'ended',
                  numeric: true,
                  cell: (mission) => when(report, mission.completedTick),
                },
                {
                  header: 'Flight',
                  sortKey: 'flight',
                  numeric: true,
                  align: 'right',
                  cell: (mission) => {
                    const flight = flightOf(mission);
                    return flight ? (
                      <TwoLine
                        top={formatDuration(flight.durationS)}
                        bottom={formatKm(flight.distanceM)}
                      />
                    ) : (
                      '—'
                    );
                  },
                },
                {
                  header: 'Fuel',
                  sortKey: 'fuel',
                  numeric: true,
                  align: 'right',
                  cell: (mission) => {
                    const flight = flightOf(mission);
                    return flight ? (
                      <TwoLine
                        top={formatKg(flight.fuelUsedKg)}
                        bottom={`${againstEstimate(flight.fuelUsedKg, flight.estimatedFuelUsedKg) ?? '—'} on estimate`}
                      />
                    ) : (
                      '—'
                    );
                  },
                },
                { header: 'Risk index', sortKey: 'risk', numeric: true, cell: riskCell },
                {
                  header: 'Objectives',
                  numeric: true,
                  align: 'right',
                  cell: (mission) => (
                    <TwoLine
                      top={`${mission.objectivesComplete} of ${mission.objectives}`}
                      bottom={
                        mission.objectivesFailed > 0
                          ? `${mission.objectivesFailed} failed`
                          : `${mission.requiredComplete} of ${mission.requiredObjectives} required`
                      }
                    />
                  ),
                },
              ]}
            />
          </div>
          <Hint>
            Each row is the mission&apos;s own record: open it for the route, the objectives, both
            risk assessments with their reasons, and the map. The risk index is a simulation index
            from 0 to 100.
          </Hint>
        </div>
      </Panel>
    </>
  );
}

/* -------------------------------------------------------------------------- Fleet */

const FLEET_SORT: Readonly<Record<string, (row: AircraftUtilisation) => SortValue>> = {
  aircraft: (row) => row.aircraft.id,
  flying: (row) => row.flightSeconds,
  distance: (row) => row.distanceM,
  fuel: (row) => row.fuelUsedKg,
  missions: (row) => row.missionsCompleted,
  mean: (row) => row.meanFlightSeconds,
  maintenance: (row) => row.maintenanceVisits,
  condition: (row) => row.aircraft.conditionPct,
  availability: (row) => row.availability,
  utilisation: (row) => row.utilisation,
};

export function FleetSection({ report }: SectionProps) {
  const navigate = useNavigate();
  const filter = useReportStore((state) => state.filter);
  const { sort, onSort } = useSort('fleet');
  const rows = sortRows(filterAircraft(report, filter), FLEET_SORT, sort);
  const { totals } = report;

  const chart = useMemo(() => {
    const share = (
      name: string,
      tone: ChartSeries['tone'],
      status: keyof AircraftUtilisation['time']['byStatus'],
    ): ChartSeries => ({
      name,
      tone,
      values: report.aircraft.map(
        (row) => Math.round((row.time.byStatus[status] / 3600) * 10) / 10,
      ),
    });
    return {
      ids: report.aircraft.map((row) => row.aircraft.id),
      series: [
        share('Airborne', 'accent', 'in_flight'),
        share('Available', 'info', 'available'),
        share('Due maintenance', 'warn', 'maintenance_due'),
        share('In maintenance', 'neutral', 'in_maintenance'),
        share('Unserviceable', 'critical', 'unserviceable'),
      ],
    };
  }, [report]);

  if (report.aircraft.length === 0) {
    return (
      <Panel title="Fleet utilisation">
        <EmptyState icon={Plane} title="The fleet has no aircraft yet" />
      </Panel>
    );
  }
  const busiest = [...report.aircraft].sort((a, b) => b.flightSeconds - a.flightSeconds)[0];
  return (
    <>
      <Panel title="Fleet totals in the period">
        <DataList columns={4}>
          <StatTile label="Flight time" value={hours(totals.flightSeconds)} unit="h" />
          <StatTile label="Distance" value={formatInteger(totals.distanceM / 1000)} unit="km" />
          <StatTile label="Fuel used" value={formatInteger(totals.fuelUsedKg)} unit="kg" />
          <StatTile
            label="Most flying"
            value={busiest && busiest.flightSeconds > 0 ? busiest.aircraft.id : null}
            detail={
              busiest && busiest.flightSeconds > 0
                ? `${hours(busiest.flightSeconds)} h in the period`
                : 'No aircraft flew'
            }
          />
        </DataList>
      </Panel>
      <Panel title="How each aircraft spent the period">
        <Chart
          label="Hours each aircraft spent airborne, available, due maintenance, in maintenance and unserviceable"
          kind="bar"
          stacked
          horizontal
          height={Math.max(120, 44 + chart.ids.length * 30)}
          categories={chart.ids}
          series={chart.series}
          unit="h"
          empty="No aircraft status is recorded for this period."
          onSelect={(index) => {
            const id = chart.ids[index];
            if (id) void navigate(`/fleet/${id}`);
          }}
        />
      </Panel>
      <Panel title="Utilisation by aircraft">
        <div className="flex flex-col gap-3">
          <FilterBar report={report} show={['aircraftId']} />
          <div className="overflow-x-auto">
            <DataTable<AircraftUtilisation>
              caption="Activity, availability and utilisation of each aircraft in the period"
              rows={rows}
              rowKey={(row) => row.aircraft.id}
              {...(sort && { sort })}
              onSort={onSort}
              columns={[
                {
                  header: 'Aircraft',
                  sortKey: 'aircraft',
                  cell: (row) => (
                    <TwoLine
                      top={<AircraftLink id={row.aircraft.id} />}
                      bottom={row.aircraft.typeName}
                    />
                  ),
                },
                {
                  header: 'Flying',
                  sortKey: 'flying',
                  numeric: true,
                  align: 'right',
                  cell: (row) => (
                    <TwoLine
                      top={`${hours(row.flightSeconds)} h`}
                      bottom={`${row.flights} flight${row.flights === 1 ? '' : 's'}`}
                    />
                  ),
                },
                {
                  header: 'Distance',
                  sortKey: 'distance',
                  numeric: true,
                  align: 'right',
                  cell: (row) => formatKm(row.distanceM),
                },
                {
                  header: 'Fuel',
                  sortKey: 'fuel',
                  numeric: true,
                  align: 'right',
                  cell: (row) => formatKg(row.fuelUsedKg),
                },
                {
                  header: 'Missions',
                  sortKey: 'missions',
                  numeric: true,
                  align: 'right',
                  cell: (row) => (
                    <TwoLine
                      top={`${row.missionsCompleted} completed`}
                      bottom={`${row.missionsFailed} failed`}
                    />
                  ),
                },
                {
                  header: 'Mean flight',
                  sortKey: 'mean',
                  numeric: true,
                  align: 'right',
                  cell: (row) =>
                    row.meanFlightSeconds === null ? '—' : formatDuration(row.meanFlightSeconds),
                },
                {
                  header: 'Maint.',
                  sortKey: 'maintenance',
                  numeric: true,
                  align: 'right',
                  cell: (row) => row.maintenanceVisits,
                },
                {
                  header: 'Condition',
                  sortKey: 'condition',
                  numeric: true,
                  align: 'right',
                  cell: (row) => `${one(row.aircraft.conditionPct)} %`,
                },
                {
                  header: 'Avail.',
                  sortKey: 'availability',
                  numeric: true,
                  align: 'right',
                  cell: (row) =>
                    row.availability === null ? '—' : `${percentText(row.availability) ?? ''} %`,
                },
                {
                  header: 'Util.',
                  sortKey: 'utilisation',
                  numeric: true,
                  align: 'right',
                  cell: (row) =>
                    row.utilisation === null ? '—' : `${percentText(row.utilisation) ?? ''} %`,
                },
              ]}
            />
          </div>
          <Hint>
            Availability and utilisation are AEGIS simulation metrics: shares of the time the
            aircraft was owned in the period. Condition is as it is now; everything else is what
            happened in the period. An aircraft that flew less was not worse, only used less.
          </Hint>
        </div>
      </Panel>
    </>
  );
}

/* -------------------------------------------------------------------------- Fuel */

const FLIGHT_SORT: Readonly<Record<string, (flight: FlightRecord) => SortValue>> = {
  flight: (flight) => flight.id,
  aircraft: (flight) => flight.aircraftId,
  arrived: (flight) => flight.arrivedTick,
  used: (flight) => flight.fuelUsedKg,
  estimate: (flight) =>
    flight.estimatedFuelUsedKg > 0
      ? (flight.fuelUsedKg - flight.estimatedFuelUsedKg) / flight.estimatedFuelUsedKg
      : null,
  rate: (flight) => (flight.distanceM > 0 ? flight.fuelUsedKg / flight.distanceM : null),
};

export function FuelSection({ report, previous }: SectionProps) {
  const filter = useReportStore((state) => state.filter);
  const { sort, onSort } = useSort('fuel');
  const rows = sortRows(filterFlights(report, filter), FLIGHT_SORT, sort);
  const { totals } = report;
  const series = useMemo(() => reportSeries(report), [report]);
  const byType = useMemo(
    () => ({
      categories: report.missionTypes
        .filter((type) => type.fuelUsedKg > 0)
        .map((type) => MISSION_TEMPLATES[type.type].label),
      series: [
        {
          name: 'Fuel used',
          tone: 'info' as const,
          values: report.missionTypes
            .filter((type) => type.fuelUsedKg > 0)
            .map((type) => Math.round(type.fuelUsedKg)),
        },
      ],
    }),
    [report],
  );

  if (report.flights.length === 0) {
    return (
      <Panel title="Fuel">
        <EmptyState icon={Fuel} title="No flight finished in this period">
          Fuel is reported for a flight in the period in which it landed.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <>
      <Panel title="Fuel in the period">
        <DataList columns={4}>
          <StatTile
            label="Fuel used"
            value={formatInteger(totals.fuelUsedKg)}
            unit="kg"
            detail={changeText(totals.fuelUsedKg, previous?.totals.fuelUsedKg ?? null, formatKg)}
          />
          <StatTile
            label="Estimated at launch"
            value={formatInteger(totals.estimatedFuelUsedKg)}
            unit="kg"
            detail={`${againstEstimate(totals.fuelUsedKg, totals.estimatedFuelUsedKg) ?? '—'} used against it`}
          />
          <StatTile
            label="Against still air"
            value={
              totals.weatherFuelKg === null
                ? null
                : `${totals.weatherFuelKg >= 0 ? '+' : '−'}${formatInteger(Math.abs(totals.weatherFuelKg))}`
            }
            unit="kg"
            detail="What the simulated weather cost or saved"
            hint="Fuel used, less what the same plans would have used in still air. Only flights that recorded it are counted."
          />
          <StatTile
            label="Per 100 km"
            value={
              totals.distanceM > 0
                ? formatInteger((totals.fuelUsedKg / totals.distanceM) * 100_000)
                : null
            }
            unit="kg"
            detail="Across every flight in the period"
          />
        </DataList>
        <div className="mt-3">
          <Hint>
            Fuel is reported as mass. The simulation has no fuel price and no costs, so none is
            shown.
          </Hint>
        </div>
      </Panel>
      <div className="grid grid-cols-2 gap-4">
        <Panel title={`Fuel used per ${series.hourly ? 'hour' : 'simulated day'}`}>
          <Chart
            label="Fuel used over the period"
            kind="bar"
            categories={series.categories}
            series={series.fuel}
            unit="kg"
            formatValue={formatInteger}
          />
        </Panel>
        <Panel title="Fuel used by mission type">
          <Chart
            label="Fuel used by mission type"
            kind="bar"
            horizontal
            categories={byType.categories}
            series={byType.series}
            unit="kg"
            formatValue={formatInteger}
            empty="No mission flight finished in this period."
          />
        </Panel>
      </div>
      <Panel title="Fuel by flight">
        <div className="flex flex-col gap-3">
          <FilterBar report={report} show={['aircraftId', 'missionType']} />
          <FilterCount shown={rows.length} of={report.flights.length} what="flights" />
          <div className="overflow-x-auto">
            <DataTable<FlightRecord>
              caption="Fuel used by each flight that finished in the period"
              rows={rows}
              rowKey={(flight) => flight.id}
              {...(sort && { sort })}
              onSort={onSort}
              columns={[
                {
                  header: 'Flight',
                  sortKey: 'flight',
                  numeric: true,
                  cell: (flight) => (
                    <TwoLine top={flight.id} bottom={`${flight.origin} → ${flight.destination}`} />
                  ),
                },
                {
                  header: 'Aircraft',
                  sortKey: 'aircraft',
                  cell: (flight) => <AircraftLink id={flight.aircraftId} />,
                },
                { header: 'Mission', cell: (flight) => <MissionLink id={flight.missionId} /> },
                {
                  header: 'Landed',
                  sortKey: 'arrived',
                  numeric: true,
                  cell: (flight) => when(report, flight.arrivedTick),
                },
                {
                  header: 'Used',
                  sortKey: 'used',
                  numeric: true,
                  align: 'right',
                  cell: (flight) => formatKg(flight.fuelUsedKg),
                },
                {
                  header: 'On estimate',
                  sortKey: 'estimate',
                  numeric: true,
                  align: 'right',
                  cell: (flight) => (
                    <TwoLine
                      top={againstEstimate(flight.fuelUsedKg, flight.estimatedFuelUsedKg) ?? '—'}
                      bottom={`est. ${formatKg(flight.estimatedFuelUsedKg)}`}
                    />
                  ),
                },
                {
                  header: 'Per 100 km',
                  sortKey: 'rate',
                  numeric: true,
                  align: 'right',
                  cell: (flight) =>
                    flight.distanceM > 0
                      ? formatKg((flight.fuelUsedKg / flight.distanceM) * 100_000)
                      : '—',
                },
              ]}
            />
          </div>
        </div>
      </Panel>
    </>
  );
}

/* -------------------------------------------------------------------------- Maintenance */

const GROUP: Readonly<Record<OutlookGroup, { label: string; tone: StatusTone }>> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  approaching: { label: 'Approaching due', tone: 'info' },
  due: { label: 'Due', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'critical' },
};

export function MaintenanceSection({ report }: SectionProps) {
  const filter = useReportStore((state) => state.filter);
  const outlook = filterOutlook(report, filter);
  const visits = filterMaintenance(report, filter);
  const series = useMemo(() => reportSeries(report), [report]);
  const count = (group: OutlookGroup) => report.outlook.filter((row) => row.group === group).length;

  return (
    <>
      <Panel title="Maintenance outlook · as things stand now">
        <div className="flex flex-col gap-3">
          <DataList columns={4}>
            {[...OUTLOOK_GROUPS].reverse().map((group) => (
              <StatTile
                key={group}
                label={GROUP[group].label}
                value={formatInteger(count(group))}
              />
            ))}
          </DataList>
          <FilterBar report={report} show={['aircraftId']} />
          {outlook.length === 0 ? (
            <EmptyState icon={Wrench} title="The fleet has no aircraft yet" />
          ) : (
            <div className="overflow-x-auto">
              <DataTable<MaintenanceOutlookRow>
                caption="Every aircraft by how near maintenance is, most pressing first"
                rows={outlook}
                rowKey={(row) => row.aircraft.id}
                columns={[
                  {
                    header: 'Aircraft',
                    cell: (row) => (
                      <TwoLine
                        top={<AircraftLink id={row.aircraft.id} />}
                        bottom={row.aircraft.typeName}
                      />
                    ),
                  },
                  {
                    header: 'Outlook',
                    cell: (row) => (
                      <StatusBadge tone={GROUP[row.group].tone}>
                        {GROUP[row.group].label}
                      </StatusBadge>
                    ),
                  },
                  {
                    header: 'Status',
                    cell: (row) => <AircraftStatusBadge status={row.aircraft.status} />,
                  },
                  {
                    header: 'Condition',
                    numeric: true,
                    align: 'right',
                    cell: (row) => (
                      <TwoLine
                        top={`${one(row.aircraft.conditionPct)} %`}
                        bottom={`${one(row.conditionMarginPct)} above due`}
                      />
                    ),
                  },
                  {
                    header: 'Since maintenance',
                    numeric: true,
                    align: 'right',
                    cell: (row) => (
                      <TwoLine
                        top={`${hours(row.aircraft.flightSecondsSinceMaintenance)} h`}
                        bottom={`${hours(row.secondsRemaining)} h remain`}
                      />
                    ),
                  },
                  { header: 'Why', cell: (row) => row.reason },
                ]}
              />
            </div>
          )}
          <Hint>
            Maintenance falls due on flying hours or on condition, whichever comes first. Start it
            from the aircraft&apos;s page in Fleet. This is an outlook from the present state, not a
            forecast.
          </Hint>
        </div>
      </Panel>
      <Panel title={`Fleet availability per ${series.hourly ? 'hour' : 'simulated day'}`}>
        <Chart
          label="Fleet availability over the period, as a percentage"
          kind="line"
          categories={series.categories}
          series={series.availability}
          unit="%"
          max={100}
          empty="No aircraft status is recorded for this period."
        />
        <div className="mt-2">
          <Hint>
            An AEGIS simulation metric: the share of aircraft time not due maintenance, in
            maintenance or unserviceable. A gap means nothing was recorded.
          </Hint>
        </div>
      </Panel>
      <Panel title="Maintenance visits">
        {visits.length === 0 ? (
          <EmptyState icon={Wrench} title="No maintenance was completed in this period">
            A visit is reported in the period in which it was completed. One under way is listed
            until then.
          </EmptyState>
        ) : (
          <DataTable<MaintenanceVisit>
            caption="Maintenance completed in the period, and maintenance under way"
            rows={visits}
            rowKey={(visit) => `${visit.aircraftId}:${visit.startedTick}`}
            columns={[
              { header: 'Aircraft', cell: (visit) => <AircraftLink id={visit.aircraftId} /> },
              {
                header: 'Started',
                numeric: true,
                cell: (visit) => when(report, visit.startedTick),
              },
              {
                header: 'Completed',
                numeric: true,
                cell: (visit) => when(report, visit.completedTick),
              },
              {
                header: 'Duration',
                numeric: true,
                align: 'right',
                cell: (visit) =>
                  visit.completedTick === null
                    ? '—'
                    : formatDuration(visit.completedTick - visit.startedTick),
              },
              {
                header: 'State',
                cell: (visit) =>
                  visit.completedTick === null ? (
                    <StatusBadge tone="info">Under way</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">Completed</StatusBadge>
                  ),
              },
            ]}
          />
        )}
      </Panel>
    </>
  );
}

/* -------------------------------------------------------------------------- Events */

const EVENT_SORT: Readonly<Record<string, (event: EventRecord) => SortValue>> = {
  event: (event) => event.id,
  type: (event) => EVENT_LABEL[event.type],
  severity: (event) => event.severity,
  started: (event) => event.startTick,
  duration: (event) => (event.status === 'resolved' ? event.endTick - event.startTick : null),
  affected: (event) => event.affectedMissionIds.length,
};

/** A flight met weather worth reporting: unsettled or worse, or a cost of more than one per cent. */
function weatherAffected(flight: FlightRecord): boolean {
  if (flight.stillAirFuelUsedKg === null || flight.stillAirDurationS === null) return false;
  const fuel = Math.abs(flight.fuelUsedKg - flight.stillAirFuelUsedKg) / flight.stillAirFuelUsedKg;
  return (flight.worstSeverity ?? 0) >= 0.2 || fuel >= 0.01;
}

const signedDuration = (seconds: number) =>
  `${seconds >= 0 ? '+' : '−'}${formatDuration(Math.abs(seconds))}`;
const signedKg = (kg: number) => `${kg >= 0 ? '+' : '−'}${formatKg(Math.abs(kg))}`;

export function EventsSection({ report }: SectionProps) {
  const filter = useReportStore((state) => state.filter);
  const { sort, onSort } = useSort('events');
  const rows = sortRows(filterEvents(report, filter), EVENT_SORT, sort);
  const series = useMemo(() => reportSeries(report), [report]);
  const weather = report.flights.filter(weatherAffected);
  const { totals } = report;

  return (
    <>
      <Panel title="Events open in the period, by type">
        {report.eventTypes.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No event was open in this period">
            The world produces closures, disruptions and findings from time to time, and reads
            severe weather from its weather.
          </EmptyState>
        ) : (
          <DataTable<EventTypeCount>
            caption="Events open in the period, by type"
            rows={report.eventTypes}
            rowKey={(type) => type.type}
            columns={[
              { header: 'Type', cell: (type) => EVENT_LABEL[type.type] },
              { header: 'Events', numeric: true, align: 'right', cell: (type) => type.events },
              {
                header: 'Time under way',
                numeric: true,
                align: 'right',
                cell: (type) => formatDuration(type.activeSeconds),
              },
              {
                header: 'Mean severity',
                numeric: true,
                align: 'right',
                cell: (type) => `${Math.round(type.meanSeverity * 100)} of 100`,
              },
              {
                header: 'Missions affected',
                numeric: true,
                align: 'right',
                cell: (type) => type.missionsAffected,
              },
            ]}
          />
        )}
      </Panel>
      <Panel title={`Events started per ${series.hourly ? 'hour' : 'simulated day'}`}>
        <Chart
          label="Events started over the period"
          kind="bar"
          height={140}
          categories={series.categories}
          series={series.events}
          unit="events"
          empty="No event started in this period."
        />
      </Panel>
      {report.events.length > 0 && (
        <Panel title="Events">
          <div className="flex flex-col gap-3">
            <FilterBar report={report} show={['eventType']} />
            <FilterCount shown={rows.length} of={report.events.length} what="events" />
            <div className="overflow-x-auto">
              <DataTable<EventRecord>
                caption="Events that were open in the period"
                rows={rows}
                rowKey={(event) => event.id}
                {...(sort && { sort })}
                onSort={onSort}
                columns={[
                  {
                    header: 'Event',
                    sortKey: 'event',
                    cell: (event) => (
                      <TwoLine top={<EventLink id={event.id} />} bottom={EVENT_LABEL[event.type]} />
                    ),
                  },
                  { header: 'State', cell: (event) => <EventStatusBadge status={event.status} /> },
                  {
                    header: 'Severity',
                    sortKey: 'severity',
                    numeric: true,
                    align: 'right',
                    cell: (event) => Math.round(event.severity * 100),
                  },
                  {
                    header: 'Where',
                    cell: (event) =>
                      event.where ??
                      (event.aircraftId ? <AircraftLink id={event.aircraftId} /> : '—'),
                  },
                  {
                    header: 'Started',
                    sortKey: 'started',
                    numeric: true,
                    cell: (event) => when(report, event.startTick),
                  },
                  {
                    header: 'Lasted',
                    sortKey: 'duration',
                    numeric: true,
                    align: 'right',
                    cell: (event) =>
                      event.status === 'resolved'
                        ? formatDuration(event.endTick - event.startTick)
                        : 'Open',
                  },
                  {
                    header: 'Missions',
                    sortKey: 'affected',
                    cell: (event) => {
                      const ids = [
                        ...new Set([
                          ...(event.raisedMissionId ? [event.raisedMissionId] : []),
                          ...event.affectedMissionIds,
                        ]),
                      ];
                      return ids.length === 0 ? (
                        '—'
                      ) : (
                        <span className="flex flex-col py-1">
                          {ids.map((id) => (
                            <MissionLink key={id} id={id} />
                          ))}
                        </span>
                      );
                    },
                  },
                ]}
              />
            </div>
            <Hint>
              An event is listed in every period it was open in. Missions are those it raised or
              that the world recorded as affected by it.
            </Hint>
          </div>
        </Panel>
      )}
      <Panel title="Weather met by flights in the period">
        <div className="flex flex-col gap-3">
          <DataList columns={4}>
            <StatTile
              label="Flights affected"
              value={formatInteger(weather.length)}
              detail={`of ${formatInteger(totals.flights)} that finished`}
              hint="Flights that met unsettled weather or worse, or whose fuel differed from still air by one per cent or more."
            />
            <StatTile
              label="Time against still air"
              value={totals.weatherDelayS === null ? null : signedDuration(totals.weatherDelayS)}
              detail="Over every flight that recorded it"
            />
            <StatTile
              label="Fuel against still air"
              value={totals.weatherFuelKg === null ? null : signedKg(totals.weatherFuelKg)}
              detail="Over every flight that recorded it"
            />
          </DataList>
          {weather.length === 0 ? (
            <EmptyState
              icon={CloudSun}
              title="No flight in the period met weather worth reporting"
            />
          ) : (
            <DataTable<FlightRecord>
              caption="Flights that met weather worth reporting, with what it cost"
              rows={weather}
              rowKey={(flight) => flight.id}
              columns={[
                { header: 'Flight', numeric: true, cell: (flight) => flight.id },
                { header: 'Mission', cell: (flight) => <MissionLink id={flight.missionId} /> },
                { header: 'Aircraft', cell: (flight) => <AircraftLink id={flight.aircraftId} /> },
                {
                  header: 'Worst met',
                  cell: (flight) =>
                    flight.worstSeverity === null ? '—' : severityWord(flight.worstSeverity),
                },
                {
                  header: 'Time',
                  numeric: true,
                  align: 'right',
                  cell: (flight) =>
                    signedDuration(flight.durationS - (flight.stillAirDurationS ?? 0)),
                },
                {
                  header: 'Fuel',
                  numeric: true,
                  align: 'right',
                  cell: (flight) => signedKg(flight.fuelUsedKg - (flight.stillAirFuelUsedKg ?? 0)),
                },
              ]}
            />
          )}
          <Hint>
            Simulated weather. Time and fuel are against the same plan flown in still air, as
            recorded when the flight landed.
          </Hint>
        </div>
      </Panel>
    </>
  );
}
