import { EVENT_LABEL, type EventType } from '../event';
import { MISSION_TEMPLATES, type MissionStatus, type MissionType } from '../mission';
import { tickToIso } from './period';
import type { EventRecord, FlightRecord, MissionRecord } from './records';
import type { AircraftUtilisation, MaintenanceOutlookRow, Report } from './summary';
import type { MaintenanceVisit } from './timeline';

/*
 * Report export (ADR 0025): a report as a table, and a table as CSV or JSON text. Pure: the same
 * report and filter give the same bytes on any machine.
 */

export const REPORT_TABLES = [
  'summary',
  'missions',
  'fleet',
  'fuel',
  'maintenance',
  'events',
] as const;
export type ReportTableName = (typeof REPORT_TABLES)[number];

/** What a report's lists are narrowed to. The screens and the export apply the same filter. */
export interface ReportFilter {
  readonly aircraftId: string | null;
  readonly missionType: MissionType | null;
  readonly missionStatus: MissionStatus | null;
  readonly eventType: EventType | null;
}

export const NO_FILTER: ReportFilter = {
  aircraftId: null,
  missionType: null,
  missionStatus: null,
  eventType: null,
};

export function filterMissions(report: Report, filter: ReportFilter): MissionRecord[] {
  return report.missions.filter(
    (mission) =>
      (filter.aircraftId === null || mission.aircraftId === filter.aircraftId) &&
      (filter.missionType === null || mission.type === filter.missionType) &&
      (filter.missionStatus === null || mission.status === filter.missionStatus),
  );
}

export function filterFlights(report: Report, filter: ReportFilter): FlightRecord[] {
  const typeOf = new Map(report.missions.map((mission) => [mission.id, mission.type]));
  return report.flights.filter(
    (flight) =>
      (filter.aircraftId === null || flight.aircraftId === filter.aircraftId) &&
      (filter.missionType === null ||
        (flight.missionId !== null && typeOf.get(flight.missionId) === filter.missionType)),
  );
}

export function filterAircraft(report: Report, filter: ReportFilter): AircraftUtilisation[] {
  return report.aircraft.filter(
    (row) => filter.aircraftId === null || row.aircraft.id === filter.aircraftId,
  );
}

export function filterOutlook(report: Report, filter: ReportFilter): MaintenanceOutlookRow[] {
  return report.outlook.filter(
    (row) => filter.aircraftId === null || row.aircraft.id === filter.aircraftId,
  );
}

export function filterMaintenance(report: Report, filter: ReportFilter): MaintenanceVisit[] {
  return [...report.maintenance, ...report.maintenanceUnderWay].filter(
    (visit) => filter.aircraftId === null || visit.aircraftId === filter.aircraftId,
  );
}

export function filterEvents(report: Report, filter: ReportFilter): EventRecord[] {
  return report.events.filter(
    (event) =>
      (filter.eventType === null || event.type === filter.eventType) &&
      (filter.aircraftId === null || event.aircraftId === filter.aircraftId),
  );
}

export type Cell = string | number | null;

export interface ReportTable {
  readonly name: ReportTableName;
  readonly title: string;
  readonly columns: readonly { readonly key: string; readonly header: string }[];
  readonly rows: readonly Readonly<Record<string, Cell>>[];
}

interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly value: (row: Row) => Cell;
}

/** Three decimal places: enough for a kilogram or a second, without floating-point noise. */
const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;
const hours = (seconds: number | null) => round(seconds === null ? null : seconds / 3600);
const km = (metres: number) => round(metres / 1000);
const percent = (fraction: number | null) => round(fraction === null ? null : fraction * 100);

function table<Row>(
  name: ReportTableName,
  title: string,
  columns: readonly Column<Row>[],
  rows: readonly Row[],
): ReportTable {
  return {
    name,
    title,
    columns: columns.map(({ key, header }) => ({ key, header })),
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column.key, column.value(row)])),
    ),
  };
}

/** A tick as two columns: simulation time in UTC, and the tick itself. */
function when<Row>(
  key: string,
  header: string,
  tick: (row: Row) => number | null,
  epochMs: number,
) {
  return [
    {
      key: `${key}_utc`,
      header: `${header} (sim UTC)`,
      value: (row: Row) => {
        const at = tick(row);
        return at === null ? null : tickToIso(at, epochMs);
      },
    },
    { key: `${key}_tick`, header: `${header} (tick)`, value: tick },
  ] satisfies Column<Row>[];
}

function summaryTable(report: Report): ReportTable {
  const { totals, fleet } = report;
  const rows: { key: string; label: string; value: Cell; unit: string }[] = [
    { key: 'flights', label: 'Flights finished', value: totals.flights, unit: 'flights' },
    { key: 'flight_hours', label: 'Flight time', value: hours(totals.flightSeconds), unit: 'h' },
    { key: 'distance', label: 'Distance flown', value: km(totals.distanceM), unit: 'km' },
    { key: 'fuel_used', label: 'Fuel used', value: round(totals.fuelUsedKg), unit: 'kg' },
    {
      key: 'fuel_estimated',
      label: 'Fuel estimated at launch',
      value: round(totals.estimatedFuelUsedKg),
      unit: 'kg',
    },
    {
      key: 'fuel_weather',
      label: 'Fuel against still air',
      value: round(totals.weatherFuelKg),
      unit: 'kg',
    },
    {
      key: 'missions_completed',
      label: 'Missions completed',
      value: totals.missionsCompleted,
      unit: 'missions',
    },
    {
      key: 'missions_failed',
      label: 'Missions failed',
      value: totals.missionsFailed,
      unit: 'missions',
    },
    {
      key: 'missions_cancelled',
      label: 'Missions cancelled',
      value: totals.missionsCancelled,
      unit: 'missions',
    },
    {
      key: 'offers_lapsed',
      label: 'Offers expired or rejected',
      value: totals.offersLapsed,
      unit: 'offers',
    },
    {
      key: 'maintenance_visits',
      label: 'Maintenance completed',
      value: totals.maintenanceVisits,
      unit: 'visits',
    },
    { key: 'events_started', label: 'Events started', value: totals.eventsStarted, unit: 'events' },
    { key: 'aircraft', label: 'Aircraft', value: fleet.aircraft, unit: 'aircraft' },
    {
      key: 'availability',
      label: 'Fleet availability (AEGIS simulation metric)',
      value: percent(fleet.availability),
      unit: '%',
    },
    {
      key: 'utilisation',
      label: 'Fleet utilisation (AEGIS simulation metric)',
      value: percent(fleet.utilisation),
      unit: '%',
    },
    {
      key: 'status_not_recorded',
      label: 'Aircraft time with no recorded status',
      value: hours(fleet.notRecordedS),
      unit: 'h',
    },
  ];
  return table(
    'summary',
    'Summary',
    [
      { key: 'metric', header: 'Metric', value: (row) => row.key },
      { key: 'label', header: 'Description', value: (row) => row.label },
      { key: 'value', header: 'Value', value: (row) => row.value },
      { key: 'unit', header: 'Unit', value: (row) => row.unit },
    ],
    rows,
  );
}

function missionsTable(report: Report, filter: ReportFilter): ReportTable {
  const flights = new Map(report.flights.map((flight) => [flight.id, flight]));
  const flightOf = (mission: MissionRecord) =>
    mission.flightId ? (flights.get(mission.flightId) ?? null) : null;
  return table<MissionRecord>(
    'missions',
    'Missions',
    [
      { key: 'mission', header: 'Mission', value: (m) => m.id },
      { key: 'title', header: 'Title', value: (m) => m.title },
      { key: 'type', header: 'Type', value: (m) => MISSION_TEMPLATES[m.type].label },
      { key: 'origin', header: 'Origin', value: (m) => m.source },
      { key: 'outcome', header: 'Outcome', value: (m) => m.status },
      { key: 'priority', header: 'Priority', value: (m) => m.priority },
      { key: 'aircraft', header: 'Aircraft', value: (m) => m.aircraftId },
      { key: 'flight', header: 'Flight', value: (m) => m.flightId },
      ...when<MissionRecord>('ended', 'Ended', (m) => m.completedTick, report.epochMs),
      ...when<MissionRecord>('launched', 'Launched', (m) => m.actualStartTick, report.epochMs),
      {
        key: 'start_delay_h',
        header: 'Launched after planned start (h)',
        value: (m) =>
          m.actualStartTick === null || m.plannedStartTick === null
            ? null
            : hours(m.actualStartTick - m.plannedStartTick),
      },
      {
        key: 'flight_h',
        header: 'Flight time (h)',
        value: (m) => hours(flightOf(m)?.durationS ?? null),
      },
      {
        key: 'distance_km',
        header: 'Distance (km)',
        value: (m) => {
          const flight = flightOf(m);
          return flight ? km(flight.distanceM) : null;
        },
      },
      {
        key: 'fuel_used_kg',
        header: 'Fuel used (kg)',
        value: (m) => round(flightOf(m)?.fuelUsedKg ?? null),
      },
      {
        key: 'fuel_estimated_kg',
        header: 'Fuel estimated at launch (kg)',
        value: (m) => round(flightOf(m)?.estimatedFuelUsedKg ?? null),
      },
      {
        key: 'fuel_still_air_kg',
        header: 'Fuel in still air (kg)',
        value: (m) => round(flightOf(m)?.stillAirFuelUsedKg ?? null),
      },
      {
        key: 'worst_weather',
        header: 'Worst weather met (0-100)',
        value: (m) => percent(flightOf(m)?.worstSeverity ?? null),
      },
      {
        key: 'risk_accepted',
        header: 'Risk as accepted (0-100)',
        value: (m) => round(m.acceptanceRisk),
      },
      { key: 'risk_launch', header: 'Risk at launch (0-100)', value: (m) => round(m.launchRisk) },
      { key: 'objectives', header: 'Objectives', value: (m) => m.objectives },
      {
        key: 'objectives_complete',
        header: 'Objectives complete',
        value: (m) => m.objectivesComplete,
      },
      { key: 'objectives_failed', header: 'Objectives failed', value: (m) => m.objectivesFailed },
      { key: 'summary', header: 'Result', value: (m) => m.summary },
    ],
    filterMissions(report, filter),
  );
}

function fleetTable(report: Report, filter: ReportFilter): ReportTable {
  return table<AircraftUtilisation>(
    'fleet',
    'Fleet utilisation',
    [
      { key: 'aircraft', header: 'Aircraft', value: (r) => r.aircraft.id },
      { key: 'type', header: 'Type', value: (r) => r.aircraft.typeName },
      { key: 'status', header: 'Status now', value: (r) => r.aircraft.status },
      {
        key: 'condition_pct',
        header: 'Condition now (%)',
        value: (r) => round(r.aircraft.conditionPct),
      },
      { key: 'flights', header: 'Flights', value: (r) => r.flights },
      { key: 'flight_h', header: 'Flight time (h)', value: (r) => hours(r.flightSeconds) },
      { key: 'mean_flight_h', header: 'Mean flight (h)', value: (r) => hours(r.meanFlightSeconds) },
      { key: 'distance_km', header: 'Distance (km)', value: (r) => km(r.distanceM) },
      { key: 'fuel_used_kg', header: 'Fuel used (kg)', value: (r) => round(r.fuelUsedKg) },
      {
        key: 'missions_completed',
        header: 'Missions completed',
        value: (r) => r.missionsCompleted,
      },
      { key: 'missions_failed', header: 'Missions failed', value: (r) => r.missionsFailed },
      {
        key: 'maintenance_visits',
        header: 'Maintenance completed',
        value: (r) => r.maintenanceVisits,
      },
      {
        key: 'availability_pct',
        header: 'Availability (%)',
        value: (r) => percent(r.availability),
      },
      { key: 'utilisation_pct', header: 'Utilisation (%)', value: (r) => percent(r.utilisation) },
      {
        key: 'status_not_recorded_h',
        header: 'Status not recorded (h)',
        value: (r) => hours(r.time.notRecordedS),
      },
      {
        key: 'total_flight_h',
        header: 'Flight time, all time (h)',
        value: (r) => hours(r.aircraft.flightSecondsTotal),
      },
    ],
    filterAircraft(report, filter),
  );
}

function fuelTable(report: Report, filter: ReportFilter): ReportTable {
  const missions = new Map(report.missions.map((mission) => [mission.id, mission]));
  return table<FlightRecord>(
    'fuel',
    'Fuel by flight',
    [
      { key: 'flight', header: 'Flight', value: (f) => f.id },
      { key: 'aircraft', header: 'Aircraft', value: (f) => f.aircraftId },
      { key: 'mission', header: 'Mission', value: (f) => f.missionId },
      {
        key: 'mission_type',
        header: 'Mission type',
        value: (f) => {
          const mission = f.missionId ? missions.get(f.missionId) : undefined;
          return mission ? MISSION_TEMPLATES[mission.type].label : null;
        },
      },
      { key: 'from', header: 'From', value: (f) => f.origin },
      { key: 'to', header: 'To', value: (f) => f.destination },
      { key: 'result', header: 'Result', value: (f) => f.status },
      ...when<FlightRecord>('arrived', 'Arrived', (f) => f.arrivedTick, report.epochMs),
      { key: 'flight_h', header: 'Flight time (h)', value: (f) => hours(f.durationS) },
      { key: 'distance_km', header: 'Distance (km)', value: (f) => km(f.distanceM) },
      { key: 'fuel_used_kg', header: 'Fuel used (kg)', value: (f) => round(f.fuelUsedKg) },
      {
        key: 'fuel_estimated_kg',
        header: 'Fuel estimated at launch (kg)',
        value: (f) => round(f.estimatedFuelUsedKg),
      },
      {
        key: 'fuel_still_air_kg',
        header: 'Fuel in still air (kg)',
        value: (f) => round(f.stillAirFuelUsedKg),
      },
      {
        key: 'fuel_per_100km_kg',
        header: 'Fuel per 100 km (kg)',
        value: (f) => (f.distanceM > 0 ? round((f.fuelUsedKg / f.distanceM) * 100_000) : null),
      },
    ],
    filterFlights(report, filter),
  );
}

function maintenanceTable(report: Report, filter: ReportFilter): ReportTable {
  return table<MaintenanceVisit>(
    'maintenance',
    'Maintenance',
    [
      { key: 'aircraft', header: 'Aircraft', value: (v) => v.aircraftId },
      ...when<MaintenanceVisit>('started', 'Started', (v) => v.startedTick, report.epochMs),
      ...when<MaintenanceVisit>('completed', 'Completed', (v) => v.completedTick, report.epochMs),
      {
        key: 'duration_h',
        header: 'Duration (h)',
        value: (v) => (v.completedTick === null ? null : hours(v.completedTick - v.startedTick)),
      },
      {
        key: 'state',
        header: 'State',
        value: (v) => (v.completedTick === null ? 'under way' : 'completed'),
      },
    ],
    filterMaintenance(report, filter),
  );
}

function eventsTable(report: Report, filter: ReportFilter): ReportTable {
  return table<EventRecord>(
    'events',
    'Events',
    [
      { key: 'event', header: 'Event', value: (e) => e.id },
      { key: 'type', header: 'Type', value: (e) => EVENT_LABEL[e.type] },
      { key: 'title', header: 'Title', value: (e) => e.title },
      { key: 'state', header: 'State', value: (e) => e.status },
      { key: 'source', header: 'Source', value: (e) => e.source },
      { key: 'severity', header: 'Severity (0-100)', value: (e) => percent(e.severity) },
      { key: 'where', header: 'Where', value: (e) => e.where },
      ...when<EventRecord>('started', 'Started', (e) => e.startTick, report.epochMs),
      ...when<EventRecord>(
        'ended',
        'Ended',
        (e) => (e.status === 'resolved' ? e.endTick : null),
        report.epochMs,
      ),
      {
        key: 'duration_h',
        header: 'Duration (h)',
        value: (e) => (e.status === 'resolved' ? hours(e.endTick - e.startTick) : null),
      },
      { key: 'aircraft', header: 'Aircraft', value: (e) => e.aircraftId },
      { key: 'raised_mission', header: 'Opportunity raised', value: (e) => e.raisedMissionId },
      {
        key: 'missions_affected',
        header: 'Missions affected',
        value: (e) => e.affectedMissionIds.join(' '),
      },
    ],
    filterEvents(report, filter),
  );
}

/** One of a report's tables, narrowed by the filter. */
export function reportTable(
  name: ReportTableName,
  report: Report,
  filter: ReportFilter = NO_FILTER,
): ReportTable {
  switch (name) {
    case 'summary':
      return summaryTable(report);
    case 'missions':
      return missionsTable(report, filter);
    case 'fleet':
      return fleetTable(report, filter);
    case 'fuel':
      return fuelTable(report, filter);
    case 'maintenance':
      return maintenanceTable(report, filter);
    case 'events':
      return eventsTable(report, filter);
  }
}

/** Characters that make a spreadsheet treat a text cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180: a header row, CRLF line ends, fields quoted only where they must be. */
export function toCsv(data: ReportTable): string {
  const lines = [
    data.columns.map((column) => csvCell(column.header)).join(','),
    ...data.rows.map((row) =>
      data.columns.map((column) => csvCell(row[column.key] ?? null)).join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export interface ExportMeta {
  readonly application: 'AEGIS';
  readonly content: string;
  readonly report: ReportTableName;
  readonly title: string;
  readonly period: {
    readonly fromTick: number;
    readonly toTick: number;
    readonly fromUtc: string;
    readonly toUtc: string;
  };
  readonly asOf: { readonly tick: number; readonly utc: string };
  readonly simulationModel: number;
  readonly filter: ReportFilter;
  readonly columns: ReportTable['columns'];
  readonly rowCount: number;
}

export function exportMeta(data: ReportTable, report: Report, filter: ReportFilter): ExportMeta {
  return {
    application: 'AEGIS',
    content:
      'Simulated data from an AEGIS world. All times are simulation time. Nothing here describes real operations.',
    report: data.name,
    title: data.title,
    period: {
      fromTick: report.period.fromTick,
      toTick: report.period.toTick,
      fromUtc: tickToIso(report.period.fromTick, report.epochMs),
      toUtc: tickToIso(report.period.toTick, report.epochMs),
    },
    asOf: { tick: report.asOfTick, utc: tickToIso(report.asOfTick, report.epochMs) },
    simulationModel: report.modelVersion,
    filter,
    columns: data.columns,
    rowCount: data.rows.length,
  };
}

/** The table and what it is, as indented JSON ending in a newline. */
export function toJson(
  data: ReportTable,
  report: Report,
  filter: ReportFilter = NO_FILTER,
): string {
  return `${JSON.stringify({ meta: exportMeta(data, report, filter), rows: data.rows }, null, 2)}\n`;
}

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\d\dZ$/, 'Z');

/**
 * `aegis-missions-20261004T2119Z-20261005T1139Z.csv`: the report and its period in simulation
 * time, so the same export has the same name on any machine.
 */
export function exportFileName(
  name: ReportTableName,
  report: Report,
  format: 'csv' | 'json',
): string {
  const from = compact(tickToIso(report.period.fromTick, report.epochMs));
  const to = compact(tickToIso(Math.min(report.period.toTick, report.asOfTick), report.epochMs));
  return `aegis-${name}-${from}-${to}.${format}`;
}
