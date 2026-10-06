import {
  PERIOD_LABEL,
  REPORT_TABLES,
  filterEvents,
  filterServices,
  filterFlights,
  filterMissions,
  type Report,
  type ReportTableName,
} from '@aegis/domain';
import {
  Button,
  EntityRow,
  Hint,
  ListPane,
  Notice,
  PageHeader,
  SegmentedControl,
  StatusBadge,
  TextField,
} from '@aegis/ui';
import { FileJson, FileSpreadsheet } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useNavigate, useParams } from 'react-router';
import { formatInteger } from '../../format';
import {
  PERIOD_KINDS,
  SECTION_LABEL,
  SECTION_QUESTION,
  defaultCustom,
  describePeriod,
  resolvePeriod,
  tickTime,
  type PeriodKind,
} from '../../reports/report-logic';
import { exportReport, loadReports, type ExportFormat } from '../../reports/report-service';
import { setExportState, setPeriodChoice, useReportStore } from '../../state/report-store';
import { useSimStore } from '../../state/sim-store';
import { SimulatedBadge } from '../shared/fleet-display';
import { useAsync } from '../shared/useAsync';
import { useLastReady } from '../shared/useStable';
import type { SectionProps } from './parts';
import {
  EventsSection,
  FleetSection,
  FuelSection,
  MaintenanceSection,
  MissionsSection,
  SummarySection,
} from './sections';
import { AerodromesSection } from './aerodromes';

const SECTIONS: Readonly<Record<ReportTableName, ComponentType<SectionProps>>> = {
  summary: SummarySection,
  missions: MissionsSection,
  fleet: FleetSection,
  fuel: FuelSection,
  maintenance: MaintenanceSection,
  events: EventsSection,
  services: AerodromesSection,
};

const SHORT_PERIOD: Readonly<Record<PeriodKind, string>> = {
  today: 'Today',
  last24h: '24 h',
  last7d: '7 d',
  last30d: '30 d',
  custom: 'Custom',
};

/** A report is re-read at most this often while the world runs, however often it checkpoints. */
const REFRESH_MS = 5000;

/**
 * Follows a value, but no more often than every `intervalMs`. The first change after a quiet
 * spell is taken at once, so an action shows in the report straight away.
 */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [held, setHeld] = useState(value);
  const taken = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, taken.current + intervalMs - performance.now());
    const timer = setTimeout(() => {
      taken.current = performance.now();
      setHeld(value);
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [value, intervalMs]);
  return held;
}

/** One line under a section's name in the list: its headline for the period. */
function headline(section: ReportTableName, report: Report): string {
  const { totals } = report;
  switch (section) {
    case 'summary':
      return `${formatInteger(totals.flights)} flights · ${(totals.flightSeconds / 3600).toFixed(1)} h`;
    case 'missions':
      return `${formatInteger(totals.missionsCompleted)} completed · ${formatInteger(totals.missionsFailed)} failed`;
    case 'fleet':
      return report.fleet.utilisation === null
        ? 'No recorded time'
        : `${(report.fleet.utilisation * 100).toFixed(1)} % utilisation`;
    case 'fuel':
      return `${formatInteger(totals.fuelUsedKg)} kg used`;
    case 'maintenance':
      return `${formatInteger(report.outlook.filter((row) => row.group === 'due' || row.group === 'unavailable').length)} due or unavailable`;
    case 'events':
      return `${formatInteger(report.events.length)} open in the period`;
    case 'services':
      return `${formatInteger(report.services.length)} services · ${formatInteger(report.aerodromes.length)} aerodromes`;
  }
}

function PeriodControls({ problem }: { readonly problem: string | null }) {
  const choice = useReportStore((state) => state.choice);
  const tick = useSimStore((state) => state.view?.checkpoint.persistedTick ?? null);
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  return (
    <div className="flex flex-col gap-2.5 border-b border-line-subtle px-3 pt-2 pb-3">
      <span className="text-2xs tracking-label text-ink-muted uppercase">
        Period · simulation time
      </span>
      <SegmentedControl<PeriodKind>
        label="Reporting period, in simulation time"
        value={choice.kind}
        options={PERIOD_KINDS.map((kind) => ({ value: kind, label: SHORT_PERIOD[kind] }))}
        onChange={(kind) => {
          // Start a custom period from the last 24 hours, so there is something to edit.
          const blank = kind === 'custom' && choice.from === '' && tick !== null && epoch !== null;
          setPeriodChoice({ kind, ...(blank && defaultCustom(tick, epoch)) });
        }}
      />
      {choice.kind === 'custom' && (
        <>
          <TextField
            label="From (simulation UTC)"
            value={choice.from}
            placeholder="YYYY-MM-DD HH:MM"
            maxLength={16}
            onChange={(from) => {
              setPeriodChoice({ from });
            }}
          />
          <TextField
            label="To (simulation UTC)"
            value={choice.to}
            placeholder="YYYY-MM-DD HH:MM"
            maxLength={16}
            onChange={(to) => {
              setPeriodChoice({ to });
            }}
          />
          {problem && <Hint>{problem}</Hint>}
        </>
      )}
      <Hint>
        {choice.kind === 'custom' ? 'A custom period' : PERIOD_LABEL[choice.kind]}, measured on the
        simulation clock. It is not the time on this computer.
      </Hint>
    </div>
  );
}

function rowsShown(section: ReportTableName, report: Report): number | null {
  const filter = useReportStore.getState().filter;
  switch (section) {
    case 'missions':
      return filterMissions(report, filter).length;
    case 'fuel':
      return filterFlights(report, filter).length;
    case 'events':
      return filterEvents(report, filter).length;
    case 'services':
      return filterServices(report, filter).length;
    default:
      return null;
  }
}

function ExportBar({
  section,
  report,
}: {
  readonly section: ReportTableName;
  readonly report: Report;
}) {
  const exported = useReportStore((state) => state.exported);
  const filter = useReportStore((state) => state.filter);
  const save = (format: ExportFormat) => {
    setExportState({ status: 'writing' });
    exportReport(section, report, filter, format).then(
      (result) => {
        setExportState({ status: 'written', result });
      },
      (reason: unknown) => {
        setExportState({
          status: 'failed',
          error: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
  };
  const rows = rowsShown(section, report);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={FileSpreadsheet}
          size="sm"
          disabled={exported.status === 'writing'}
          onClick={() => {
            save('csv');
          }}
        >
          Export CSV
        </Button>
        <Button
          icon={FileJson}
          size="sm"
          disabled={exported.status === 'writing'}
          onClick={() => {
            save('json');
          }}
        >
          Export JSON
        </Button>
        <span className="text-xs text-ink-muted">
          Exports this section for the period
          {rows === null ? '' : `, as filtered (${formatInteger(rows)} rows)`}. Simulated data only.
        </span>
      </div>
      {exported.status === 'written' && (
        <Notice tone="info" title={`Exported ${exported.result.fileName}`}>
          <span className="telemetry text-xs break-all">{exported.result.path}</span>
        </Notice>
      )}
      {exported.status === 'failed' && (
        <Notice tone="critical" title="The export was not written">
          {exported.error}
        </Notice>
      )}
    </div>
  );
}

/** Reports: what the simulated world has done, derived from what it recorded (ADR 0024). */
export function ReportsScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const section: ReportTableName =
    REPORT_TABLES.find((name) => name === params.section) ?? 'summary';

  const choice = useReportStore((state) => state.choice);
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const seq = useThrottled(
    useSimStore((state) => state.view?.checkpoint.persistedSeq ?? 0),
    REFRESH_MS,
  );
  const persistedTick = useSimStore((state) => state.view?.checkpoint.persistedTick ?? null);
  // The period is fixed for a given checkpoint: it moves on only when the report is re-read.
  const asOf = useRef<{ seq: number; tick: number | null }>({ seq: -1, tick: null });
  if (asOf.current.seq !== seq || asOf.current.tick === null) {
    asOf.current = { seq, tick: persistedTick };
  }
  const tick = asOf.current.tick;

  const resolved =
    tick === null || epoch === null
      ? { period: null, problem: null }
      : resolvePeriod(choice, tick, epoch);
  const period = resolved.period;
  const key = period ? `${seq}:${period.fromTick}:${period.toTick}` : 'none';
  const loading = useAsync(key, () => (period ? loadReports(period, seq) : Promise.resolve(null)));
  const reports = useLastReady(loading);
  const Section = SECTIONS[section];

  // An export notice belongs to the section and period it was made from.
  useEffect(() => {
    setExportState({ status: 'idle' });
  }, [section, choice]);

  return (
    <div className="flex size-full">
      <ListPane title="Reports">
        <PeriodControls problem={resolved.problem} />
        {REPORT_TABLES.map((name) => (
          <EntityRow
            key={name}
            code={SECTION_LABEL[name]}
            primary={SECTION_QUESTION[name]}
            {...(reports && { secondary: headline(name, reports.current) })}
            active={name === section}
            onSelect={() => {
              void navigate(name === 'summary' ? '/reports' : `/reports/${name}`);
            }}
          />
        ))}
      </ListPane>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="flex max-w-6xl flex-col gap-4">
          <PageHeader
            kicker="Reports · simulation time"
            title={SECTION_LABEL[section]}
            subtitle={
              reports
                ? describePeriod(
                    reports.current.period,
                    reports.current.asOfTick,
                    reports.current.epochMs,
                  )
                : SECTION_QUESTION[section]
            }
            badges={
              <>
                <SimulatedBadge />
                {reports && (
                  <StatusBadge tone="neutral">
                    As of {tickTime(reports.current.asOfTick, reports.current.epochMs)} UTC
                  </StatusBadge>
                )}
              </>
            }
          />
          {loading.status === 'failed' && (
            <Notice tone="critical" title="The report could not be read">
              {loading.error}
            </Notice>
          )}
          {!reports && loading.status !== 'failed' && (
            <Hint>
              {resolved.problem ??
                (tick === null
                  ? 'Waiting for the world to be saved for the first time.'
                  : 'Reading the report.')}
            </Hint>
          )}
          {reports && (
            <>
              <ExportBar section={section} report={reports.current} />
              <Section report={reports.current} previous={reports.previous} />
              <Hint>
                Derived from this world&apos;s recorded flights, missions, events and log as of the
                simulation time above. Nothing here is stored separately, and nothing describes real
                operations.
              </Hint>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
