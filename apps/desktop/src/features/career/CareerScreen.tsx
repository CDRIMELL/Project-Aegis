import { CAREER, counter, dayHeadline, type CareerDay } from '@aegis/domain';
import {
  Button,
  DataList,
  DataTable,
  EmptyState,
  Hint,
  Notice,
  PageHeader,
  Panel,
  StatTile,
  StatusBadge,
} from '@aegis/ui';
import { Flag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  careerRecord,
  commandTime,
  readinessText,
  recordValue,
  type RecordRow,
} from '../../career/career-logic';
import { endCommandDay, leaveToMenu } from '../../career/service';
import { formatDuration } from '../../format';
import { useSimStore } from '../../state/sim-store';
import { SimulatedBadge } from '../shared/fleet-display';
import { formatTick } from '../shared/mission-display';

function RecordPanel({
  title,
  rows,
  note,
}: {
  readonly title: string;
  readonly rows: readonly RecordRow[];
  readonly note?: string | undefined;
}) {
  return (
    <Panel title={title}>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-line-subtle py-1 last:border-b-0"
          >
            <dt className="text-sm text-ink-secondary">{row.label}</dt>
            <dd
              className={`telemetry text-base ${row.value === 0 ? 'text-ink-disabled' : 'text-ink'}`}
            >
              {recordValue(row.value, row.unit)}
            </dd>
          </div>
        ))}
      </dl>
      {note && <Hint>{note}</Hint>}
    </Panel>
  );
}

/**
 * The career record (ADR 0031): what has happened under this command, day after day. Every
 * figure is a count of something the simulation logged; nothing is scored and nothing is reset.
 */
export function CareerScreen() {
  const navigate = useNavigate();
  const career = useSimStore((state) => state.view?.career ?? null);
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const aircraft = useSimStore((state) => state.view?.fleet.aircraft ?? null);
  const rejection = useSimStore((state) => state.rejection);
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const record = useMemo(() => (career ? careerRecord(career.totals.counters) : []), [career]);

  if (!career || career.day === null) {
    return (
      <EmptyState icon={Flag} title="No command day is open">
        The career record begins when command is taken.
      </EmptyState>
    );
  }
  const { day, totals } = career;
  const readiness = readinessText(totals.readiness);
  const ready =
    aircraft && aircraft.length > 0
      ? Math.round(
          (aircraft.filter((each) => each.status === 'available' || each.status === 'in_flight')
            .length /
            aircraft.length) *
            100,
        )
      : null;
  const mayEndIn = Math.max(0, (career.dayMayEndTick ?? 0) - tick);
  const history: CareerDay[] = [day, ...[...career.recentDays].reverse()];
  const older = career.closedDays - career.recentDays.length;

  const end = () => {
    setEnding(true);
    void endCommandDay().then((closed) => {
      setEnding(false);
      setConfirming(false);
      if (closed !== null) void navigate('/summary');
    });
  };

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <PageHeader
        kicker="Career overview"
        title={`Day ${day.number}`}
        subtitle={`Command time ${commandTime(totals.commandSeconds)}, simulated · in command since ${formatTick(epoch, career.recentDays[0]?.startedTick ?? day.startedTick) ?? '—'} UTC`}
        badges={<SimulatedBadge />}
        actions={
          <>
            <Button
              variant="primary"
              disabled={mayEndIn > 0 || ending}
              title={
                mayEndIn > 0
                  ? `A command day runs for at least ${formatDuration(CAREER.minDayS)} of simulation time. This one can be ended in ${formatDuration(mayEndIn)}.`
                  : 'Close this command day and see its summary.'
              }
              onClick={() => {
                setConfirming(true);
              }}
            >
              End command day
            </Button>
            <Button
              onClick={() => {
                void leaveToMenu().then(() => navigate('/menu'));
              }}
            >
              Main menu
            </Button>
          </>
        }
      />

      {confirming && (
        <Notice tone="info" title={`End day ${day.number}?`}>
          <p>
            The day is closed and summed up, and day {day.number + 1} opens at the same moment. The
            world is paused while you read the summary and the next brief; no time passes between
            days, and nothing in the record is reset.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" disabled={ending} onClick={end}>
              End day {day.number}
            </Button>
            <Button
              size="sm"
              disabled={ending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Stay in command
            </Button>
          </div>
        </Notice>
      )}
      {rejection && confirming && (
        <Notice tone="warn" title="The day was not ended">
          {rejection}
        </Notice>
      )}

      <Panel title="Readiness">
        <DataList columns={4}>
          <StatTile
            label="Now"
            value={ready === null ? null : String(ready)}
            unit="%"
            hint="The share of aircraft that are available or flying at this moment."
          />
          <StatTile
            label="Career mean"
            value={readiness.mean}
            hint="Over every second of every command day."
          />
          <StatTile label="Lowest" value={readiness.low} />
          <StatTile label="Highest" value={readiness.high} />
        </DataList>
        <Hint>
          Readiness is the share of aircraft available or flying. It is an AEGIS simulation measure,
          the same one the reports call availability.
        </Hint>
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        {record.map((group) => (
          <RecordPanel key={group.title} title={group.title} rows={group.rows} note={group.note} />
        ))}
      </div>

      <Panel
        title="Career history"
        actions={
          <StatusBadge tone="neutral">
            {totals.days} day{totals.days === 1 ? '' : 's'}
          </StatusBadge>
        }
      >
        <DataTable<CareerDay>
          caption="Command days, newest first"
          rows={history}
          rowKey={(each) => String(each.number)}
          columns={[
            {
              header: 'Day',
              cell: (each) => (
                <span className="telemetry">Day {String(each.number).padStart(2, '0')}</span>
              ),
            },
            {
              header: 'Began (sim, UTC)',
              cell: (each) => (
                <span className="telemetry">{formatTick(epoch, each.startedTick)}</span>
              ),
            },
            {
              header: 'In command',
              numeric: true,
              align: 'right',
              cell: (each) => commandTime((each.endedTick ?? tick) - each.startedTick),
            },
            {
              header: 'Completed',
              numeric: true,
              align: 'right',
              cell: (each) => counter(each.counters, 'missions.completed'),
            },
            {
              header: 'Failed',
              numeric: true,
              align: 'right',
              cell: (each) => counter(each.counters, 'missions.failed'),
            },
            {
              header: 'What it was',
              cell: (each) =>
                each.endedTick === null ? (
                  <span className="text-ink-muted">In progress. {dayHeadline(each)}</span>
                ) : (
                  dayHeadline(each)
                ),
            },
          ]}
        />
        {older > 0 && (
          <Hint>
            The {career.recentDays.length} most recent closed days are listed. {older} earlier day
            {older === 1 ? ' is' : 's are'} kept and counted in every total.
          </Hint>
        )}
      </Panel>
    </div>
  );
}
