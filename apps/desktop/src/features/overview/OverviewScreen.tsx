import {
  EVENT_AFFECTS,
  conditionsAt,
  isOpenEvent,
  severityWord,
  type Conditions,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import {
  Button,
  DataField,
  DataList,
  DataTable,
  EmptyState,
  EntityRow,
  Hint,
  ListPane,
  PageHeader,
  Panel,
} from '@aegis/ui';
import { CloudSun, MapPin, Route } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { formatInteger } from '../../format';
import { focusEvent } from '../../map/environment-binding';
import { useSimStore } from '../../state/sim-store';
import { SimulatedBadge } from '../shared/fleet-display';
import { formatTick, relativeTick } from '../shared/mission-display';
import { useStable } from '../shared/useStable';
import {
  ConditionsFields,
  EventStatusBadge,
  SeverityBadge,
  eventPlace,
  eventTypeLabel,
  formatCloud,
  formatPrecipitation,
  formatWind,
} from '../shared/weather-display';

/** The forecast is shown at these hours ahead. It is exact: the weather is computed (ADR 0021). */
const TREND_HOURS = [3, 6, 12] as const;
/** Conditions are recomputed for a new time this often, in ticks. */
const REFRESH_TICKS = 600;

interface BaseConditions {
  readonly place: RoutePoint;
  readonly aircraft: readonly string[];
  readonly now: Conditions;
  readonly trend: readonly Conditions[];
}

/** Current and coming conditions at every aerodrome where the fleet has an aircraft. */
function useBaseConditions(): BaseConditions[] {
  const weather = useStable(useSimStore((state) => state.view?.weather ?? null));
  const fleet = useStable(
    useSimStore((state) =>
      (state.view?.fleet.aircraft ?? []).map((aircraft) => ({
        id: aircraft.id,
        place: aircraft.location ?? aircraft.home,
      })),
    ),
  );
  const tick = useSimStore((state) => {
    const now = state.view?.clock.tick ?? 0;
    return now - (now % REFRESH_TICKS);
  });
  return useMemo(() => {
    if (!weather) return [];
    const byPlace = new Map<string, { place: RoutePoint; aircraft: string[] }>();
    for (const { id, place } of fleet) {
      const key = place.refId ?? `${place.lat},${place.lon}`;
      const entry = byPlace.get(key) ?? { place, aircraft: [] };
      entry.aircraft.push(id);
      byPlace.set(key, entry);
    }
    return [...byPlace.values()].map(({ place, aircraft }) => ({
      place,
      aircraft,
      now: conditionsAt(weather, tick, place, 0),
      trend: TREND_HOURS.map((hours) => conditionsAt(weather, tick + hours * 3600, place, 0)),
    }));
  }, [weather, fleet, tick]);
}

function trendWord(now: Conditions, later: Conditions): string {
  const change = later.severity - now.severity;
  const word = severityWord(later.severity);
  if (Math.abs(change) < 0.1) return `${word}, steady`;
  return `${word}, ${change > 0 ? 'worsening' : 'improving'}`;
}

function ConditionsPanel() {
  const bases = useBaseConditions();
  if (bases.length === 0) {
    return (
      <Panel title="Conditions at fleet aerodromes">
        <Hint>Conditions appear once the fleet has aircraft.</Hint>
      </Panel>
    );
  }
  return (
    <Panel title="Conditions at fleet aerodromes">
      <div className="flex flex-col gap-3">
        <DataTable<BaseConditions>
          caption="Simulated surface conditions now and the trend over twelve hours"
          rows={bases}
          rowKey={(row) => row.place.refId ?? row.place.name}
          columns={[
            {
              header: 'Aerodrome',
              cell: (row) => row.place.code ?? row.place.name,
              numeric: true,
            },
            { header: 'Now', cell: (row) => <SeverityBadge severity={row.now.severity} /> },
            { header: 'Wind', numeric: true, cell: (row) => formatWind(row.now) },
            { header: 'Cloud', cell: (row) => formatCloud(row.now) },
            {
              header: 'Vis',
              numeric: true,
              align: 'right',
              cell: (row) => `${row.now.visibilityKm.toFixed(0)} km`,
            },
            { header: 'Precip', cell: (row) => formatPrecipitation(row.now.precipitation) },
            {
              header: 'Temp',
              numeric: true,
              align: 'right',
              cell: (row) => `${row.now.temperatureC.toFixed(0)} °C`,
            },
            ...TREND_HOURS.map((hours, index) => ({
              header: `+${hours} h`,
              cell: (row: BaseConditions) => trendWord(row.now, row.trend[index] as Conditions),
            })),
            {
              header: 'Aircraft',
              numeric: true,
              align: 'right' as const,
              cell: (row: BaseConditions) => formatInteger(row.aircraft.length),
            },
          ]}
        />
        <Hint>
          Simulated weather, computed from the world's seed, the time and the place. It is not real
          weather. The trend is exact: the simulation will fly through these same conditions.
        </Hint>
      </div>
    </Panel>
  );
}

function EventDetail({ event }: { readonly event: WorldEvent }) {
  const navigate = useNavigate();
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const weather = useStable(useSimStore((state) => state.view?.weather ?? null));
  const when = (value: number) =>
    `${formatTick(epoch, value) ?? ''} (${relativeTick(tick, value) ?? ''})`;
  const at = event.centre ?? event.place;
  const here = useMemo(
    () => (weather && at ? conditionsAt(weather, tick - (tick % REFRESH_TICKS), at, 0) : null),
    [weather, at, tick],
  );
  const lasting = event.type === 'maintenance_finding';

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <PageHeader
        kicker={eventTypeLabel(event)}
        title={event.id}
        subtitle={event.title}
        badges={
          <>
            <SimulatedBadge />
            <EventStatusBadge status={event.status} />
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        {at && (
          <Button
            icon={MapPin}
            onClick={() => {
              focusEvent(event);
              void navigate('/operations');
            }}
          >
            Show on map
          </Button>
        )}
        {event.missionId && (
          <Button
            icon={Route}
            onClick={() => {
              void navigate(`/missions/${event.missionId ?? ''}`);
            }}
          >
            Open the opportunity it raised
          </Button>
        )}
      </div>
      <p className="cursor-text text-sm text-ink-secondary select-text">{event.description}</p>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Event">
          <DataList>
            <DataField label="Type" value={eventTypeLabel(event)} prose />
            <DataField
              label="Source"
              value={
                event.source === 'derived' ? 'Read from the weather' : 'Generated by the world'
              }
              hint={
                event.source === 'derived'
                  ? 'Raised because the simulated weather is severe here. Nothing was rolled.'
                  : "Generated from the world's seeded random stream, at a controlled rate."
              }
              prose
            />
            <DataField label="Severity" value={`${Math.round(event.severity * 100)} of 100`} />
            <DataField label="Where" value={eventPlace(event)} prose />
            <DataField label="Announced" value={formatTick(epoch, event.createdTick)} />
            <DataField label="Starts" value={when(event.startTick)} />
            <DataField
              label="Ends"
              value={lasting ? 'When the aircraft has been maintained' : when(event.endTick)}
              prose={lasting}
            />
          </DataList>
        </Panel>
        <Panel title="Consequences">
          <div className="flex flex-col gap-2">
            <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-ink-secondary">
              {EVENT_AFFECTS[event.type].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Hint>
              {event.type === 'aerodrome_closure'
                ? 'Aircraft already airborne and bound for the aerodrome still land there. The planner refuses a departure from it, and a plan that would arrive during the closure.'
                : event.type === 'severe_weather'
                  ? 'The effect is the weather itself: the planner and the simulation both fly through it.'
                  : event.type === 'navigation_disruption'
                    ? 'A route through the area is allowed, with a warning and a higher risk index.'
                    : event.type === 'logistics_disruption'
                      ? 'An urgent delivery is offered in Missions while the disruption lasts.'
                      : 'The aircraft cannot launch until maintenance has been done. Start it from Fleet.'}
            </Hint>
          </div>
        </Panel>
      </div>
      {here && (
        <Panel title="Conditions there now">
          <ConditionsFields conditions={here} columns={3} />
        </Panel>
      )}
    </div>
  );
}

function eventRowDetail(event: WorldEvent, tick: number): string {
  const place = eventPlace(event) ?? '';
  if (event.status === 'scheduled') {
    return `${place} · starts ${relativeTick(tick, event.startTick) ?? ''}`;
  }
  if (event.status === 'active' && event.type !== 'maintenance_finding') {
    return `${place} · ends ${relativeTick(tick, event.endTick) ?? ''}`;
  }
  return place;
}

/** The environment and what is happening in the world: conditions, events and their consequences. */
export function OverviewScreen() {
  const events = useSimStore((state) => state.view?.events.events ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const { eventId } = useParams();
  const navigate = useNavigate();

  const all = events ?? [];
  const open = all.filter((event) => isOpenEvent(event.status));
  const finished = all.filter((event) => !isOpenEvent(event.status)).slice(0, 30);
  const selected = all.find((event) => event.id === eventId) ?? null;

  return (
    <div className="flex size-full">
      <ListPane title={`Events (${open.length} open)`}>
        <EntityRow
          code="Environment"
          primary="Conditions at fleet aerodromes"
          secondary="Now and over the next twelve hours"
          active={selected === null}
          onSelect={() => {
            void navigate('/overview');
          }}
        />
        {[...open, ...finished].map((event) => (
          <EntityRow
            key={event.id}
            code={event.id}
            primary={event.title}
            secondary={eventRowDetail(event, tick)}
            badge={<EventStatusBadge status={event.status} />}
            active={event.id === selected?.id}
            onSelect={() => {
              void navigate(`/overview/${event.id}`);
            }}
          />
        ))}
        {all.length === 0 && (
          <div className="px-3 py-3">
            <Hint>No events yet. The world produces them from time to time.</Hint>
          </div>
        )}
      </ListPane>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {selected ? (
          <EventDetail key={selected.id} event={selected} />
        ) : (
          <div className="flex max-w-5xl flex-col gap-4">
            <PageHeader
              kicker="Overview"
              title="Environment and events"
              subtitle="The simulated world as it is now, and what is changing in it."
              badges={<SimulatedBadge />}
            />
            <ConditionsPanel />
            <Panel title="Open events">
              {open.length === 0 ? (
                <EmptyState icon={CloudSun} title="Nothing is announced or under way">
                  Closures, disruptions and severe weather appear here, each with what it affects.
                </EmptyState>
              ) : (
                <DataTable<WorldEvent>
                  caption="Events that are announced or under way"
                  rows={open}
                  rowKey={(event) => event.id}
                  columns={[
                    { header: 'Event', numeric: true, cell: (event) => event.id },
                    { header: 'What', cell: (event) => event.title },
                    {
                      header: 'State',
                      cell: (event) => <EventStatusBadge status={event.status} />,
                    },
                    {
                      header: 'When',
                      cell: (event) => eventRowDetail(event, tick).split(' · ').at(-1) ?? '',
                    },
                    { header: 'Affects', cell: (event) => EVENT_AFFECTS[event.type].join('; ') },
                  ]}
                />
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
