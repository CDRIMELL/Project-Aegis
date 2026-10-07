import { counter, dayHeadline, type CareerDay, type SimInstant } from '@aegis/domain';
import { Button, DataList, DataTable, Hint, Panel, StatTile, StatusBadge } from '@aegis/ui';
import { useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { dailyBrief } from '../../career/brief-logic';
import {
  DAY_LOG_TYPES,
  commandTime,
  dayEntries,
  notableEntries,
  readinessText,
  recordChanges,
  recordValue,
  totalsBefore,
  type NotableEntry,
  type RecordChange,
} from '../../career/career-logic';
import { loadLogBetween } from '../../sim/log-queries';
import { useSimStore } from '../../state/sim-store';
import { formatTick } from '../shared/mission-display';
import { useAsync } from '../shared/useAsync';
import { BriefItems, FrontFrame, FrontTitle, Kicker } from './parts';

const NOTABLE_TONE = { critical: 'critical', warn: 'warn', info: 'info', ok: 'ok' } as const;

function Notable({
  entries,
  empty,
  epoch,
}: {
  readonly entries: readonly NotableEntry[];
  readonly empty: string;
  readonly epoch: SimInstant;
}) {
  if (entries.length === 0) return <Hint>{empty}</Hint>;
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry) => (
        <li key={entry.seq} className="flex items-start gap-2.5 text-sm">
          <span className="telemetry shrink-0 text-ink-muted">
            {formatTick(epoch, entry.tick)?.slice(11)}
          </span>
          <StatusBadge tone={NOTABLE_TONE[entry.tone]}>
            {entry.kind === 'order' ? 'Order' : 'World'}
          </StatusBadge>
          <span className="min-w-0 text-ink-secondary">{entry.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** How many entries of each kind the summary lists; the counters hold the rest. */
const LISTED = 14;

function Summary({ day }: { readonly day: CareerDay }) {
  const navigate = useNavigate();
  const view = useSimStore((state) => state.view);
  const persisted = view?.checkpoint.persistedSeq ?? 0;
  const ended = day.endedTick ?? day.startedTick;
  const log = useAsync(`day-log:${day.number}:${persisted}`, () =>
    loadLogBetween(day.startedTick, ended, DAY_LOG_TYPES),
  );
  const notable = useMemo(
    () => (log.status === 'ready' ? notableEntries(dayEntries(log.value, day)) : null),
    [log, day],
  );
  const brief = useMemo(() => (view ? dailyBrief(view) : null), [view]);
  if (!view || !brief) return null;

  const of = (name: string) => counter(day.counters, name);
  const readiness = readinessText(day.readiness);
  const totals = view.career.closedTotals;
  const changes = recordChanges(totalsBefore(totals, day.counters), totals.counters);
  const outstanding = [...brief.priorities, ...brief.watch];
  const events = notable?.filter((entry) => entry.kind === 'event') ?? [];
  const orders = notable?.filter((entry) => entry.kind === 'order') ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Kicker>Command summary</Kicker>
          <FrontTitle>Day {day.number}</FrontTitle>
          <p className="mt-1 text-sm text-ink-muted">
            <span className="telemetry">{formatTick(view.epoch, day.startedTick)}</span> to{' '}
            <span className="telemetry">{formatTick(view.epoch, ended)}</span> UTC, simulation time
            · {commandTime(ended - day.startedTick)} in command
          </p>
          <p className="mt-2 text-lg text-ink">{dayHeadline(day)}</p>
        </div>
        <StatusBadge tone="ok">Simulated</StatusBadge>
      </div>

      <Panel title="Operational performance">
        <DataList columns={4}>
          <StatTile
            label="Missions completed"
            value={String(of('missions.completed'))}
            detail={`${of('missions.completed.commander')} on your orders, ${of('missions.completed.routine')} by routine tasking`}
          />
          <StatTile
            label="Missions failed"
            value={String(of('missions.failed'))}
            detail={`${of('missions.aborted')} aborted in flight`}
          />
          <StatTile
            label="Not away on time"
            value={String(of('missions.delayed'))}
            detail="Scheduled launches that passed on the ground"
          />
          <StatTile
            label="Flights"
            value={String(of('flights.completed'))}
            detail={`${(of('flights.seconds') / 3600).toFixed(1)} h flown`}
          />
          <StatTile
            label="Readiness, mean"
            value={readiness.mean}
            detail={
              readiness.low === null
                ? 'Not recorded'
                : `Lowest ${readiness.low}, highest ${readiness.high ?? '—'}`
            }
            hint="The share of aircraft available or flying, over every second of the day."
          />
          <StatTile
            label="Fell due maintenance"
            value={String(of('aircraft.maintenanceDue'))}
            detail={`${of('aircraft.maintained')} maintained`}
          />
          <StatTile
            label="Events"
            value={String(of('events.total'))}
            detail="In the operating area"
          />
          <StatTile
            label="Orders given"
            value={String(of('orders.total'))}
            detail="Commands that committed or withdrew something"
          />
        </DataList>
      </Panel>

      <div className="grid grid-cols-2 gap-5">
        <Panel title="What the world did">
          {log.status === 'failed' && <Hint>The day’s log could not be read: {log.error}</Hint>}
          {notable && (
            <Notable
              entries={events.slice(-LISTED)}
              empty="Nothing out of the ordinary. Routine sorties are in the totals."
              epoch={view.epoch}
            />
          )}
          {events.length > LISTED && (
            <Hint>
              The last {LISTED} of {events.length}. The whole log is on the System screen.
            </Hint>
          )}
        </Panel>
        <Panel title="Decisions made">
          {notable && (
            <Notable
              entries={orders.slice(-LISTED)}
              empty="You gave no orders. The world ran on routine tasking."
              epoch={view.epoch}
            />
          )}
          {orders.length > LISTED && (
            <Hint>
              The last {LISTED} of {orders.length}.
            </Hint>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Panel title="Aircraft status at the end of the day">
          <DataList columns={2}>
            <StatTile label="Available" value={String(brief.air.available)} />
            <StatTile label="Airborne" value={String(brief.air.airborne)} />
            <StatTile label="Being prepared or turned round" value={String(brief.air.servicing)} />
            <StatTile label="Unavailable" value={String(brief.air.unavailable)} />
          </DataList>
        </Panel>
        <Panel title="Outstanding">
          <BriefItems
            items={outstanding}
            empty="Nothing is outstanding. The next day opens on a clear desk."
          />
        </Panel>
      </div>

      <Panel
        title="Career totals"
        actions={
          <StatusBadge tone="neutral">
            {totals.days} day{totals.days === 1 ? '' : 's'} · {commandTime(totals.commandSeconds)}
          </StatusBadge>
        }
      >
        {changes.length === 0 ? (
          <Hint>Day {day.number} moved nothing in the record.</Hint>
        ) : (
          <DataTable<RecordChange>
            caption={`How day ${day.number} changed the career record`}
            rows={changes}
            rowKey={(change) => `${change.group}:${change.label}`}
            columns={[
              { header: 'Record', cell: (change) => change.group },
              { header: 'Figure', cell: (change) => change.label },
              {
                header: 'Before',
                numeric: true,
                align: 'right',
                cell: (change) => recordValue(change.before, change.unit),
              },
              {
                header: 'Now',
                numeric: true,
                align: 'right',
                cell: (change) => (
                  <span className="font-semibold text-ink">
                    {recordValue(change.after, change.unit)}
                  </span>
                ),
              },
            ]}
          />
        )}
        <Hint>Totals are the sum of every command day. Nothing is reset when a day ends.</Hint>
      </Panel>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            void navigate('/brief');
          }}
        >
          Begin day {day.number + 1}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void navigate('/menu');
          }}
        >
          Main menu
        </Button>
        <span className="text-sm text-ink-muted">
          The world is paused where you left it. No time passes between days.
        </span>
      </div>
    </div>
  );
}

/** The summary of the command day that has just closed (ADR 0031). */
export function CommandSummary() {
  const day = useSimStore((state) => state.view?.career.recentDays.at(-1) ?? null);
  if (!day) return <Navigate to="/menu" replace />;
  return (
    <FrontFrame wide>
      <Summary day={day} />
    </FrontFrame>
  );
}
