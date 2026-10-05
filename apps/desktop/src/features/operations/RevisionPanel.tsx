import { addMs, formatUtc, type RoutePoint, type SimInstant } from '@aegis/domain';
import type { AircraftState, FlightView } from '@aegis/sim';
import {
  Button,
  ConstraintList,
  DataTable,
  DetailPanel,
  Hint,
  IconButton,
  ListRow,
  Notice,
  ResultList,
  SectionLabel,
  SegmentedControl,
} from '@aegis/ui';
import { Check, Plane, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { aerodromePoint, type AerodromeRow } from '../../fleet/catalogue';
import {
  insertWaypoint,
  isEditablePoint,
  removeWaypoint,
  type PlanDraft,
} from '../../fleet/plan-edit';
import { formatDuration, formatInteger, formatKg, formatKm } from '../../format';
import {
  abortLanding,
  currentEstimate,
  draftRemainder,
  objectivesAffected,
  proposalEstimate,
  rankCandidates,
  remainderOf,
  revisionDraft,
  type OptionEstimate,
} from '../../operations/inflight-logic';
import { loadAerodromesNear } from '../../reference/queries';
import { simClient } from '../../sim/client';
import { select } from '../../state/map-store';
import {
  cancelPlanning,
  editDraft,
  setDraft,
  setRevision,
  type RevisionDraft,
} from '../../state/plan-store';
import { useSimStore } from '../../state/sim-store';
import { AerodromePicker, SimulatedBadge } from '../shared/fleet-display';
import { useAsync } from '../shared/useAsync';
import { usePlanContext } from '../shared/usePlanContext';
import { formatWind } from '../shared/weather-display';

/*
 * Changing the rest of a flight that is in the air (ADR 0026): choose, compare what it would come
 * to with how things stand, and confirm. Everything shown is computed with the functions the
 * simulation itself uses when the command arrives.
 */

const TITLE = {
  reroute: 'Reroute',
  divert: 'Divert',
  return: 'Return to base',
} as const;

/** The flight is re-read for estimates this often, in ticks: a projection flies the whole route. */
const ESTIMATE_TICKS = 60;

/** The flight as it was when the estimate bucket last changed, so estimates are not rebuilt ten times a second. */
function useSampledFlight(flight: FlightView): FlightView {
  const bucket = useSimStore((state) => Math.floor((state.view?.clock.tick ?? 0) / ESTIMATE_TICKS));
  const held = useRef({ bucket, flight, revisions: flight.revisions.length, hold: flight.hold });
  if (
    held.current.bucket !== bucket ||
    held.current.revisions !== flight.revisions.length ||
    held.current.hold !== flight.hold
  ) {
    held.current = { bucket, flight, revisions: flight.revisions.length, hold: flight.hold };
  }
  return held.current.flight;
}

const clock = (epoch: SimInstant | null, tick: number) =>
  epoch === null ? '—' : formatUtc(addMs(epoch, tick * 1000)).slice(11, 16);

interface Row {
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

function comparison(
  epoch: SimInstant | null,
  before: OptionEstimate,
  after: OptionEstimate | null,
): Row[] {
  const cell = (read: (estimate: OptionEstimate) => string) => ({
    before: read(before),
    after: after ? read(after) : '—',
  });
  return [
    {
      label: 'Lands at',
      ...cell((e) => e.projection.destination.code ?? e.projection.destination.name),
    },
    { label: 'Distance to go', ...cell((e) => formatKm(e.projection.remainingM)) },
    {
      label: 'Arrival (sim UTC)',
      ...cell((e) =>
        e.projection.completes
          ? `${clock(epoch, e.projection.arrivalTick)} (${formatDuration(e.projection.remainingS)})`
          : 'Does not arrive',
      ),
    },
    {
      label: 'Landing fuel',
      ...cell((e) => (e.projection.completes ? formatKg(e.projection.landingFuelKg) : 'Runs out')),
    },
    {
      label: 'Hold for closure',
      ...cell((e) =>
        e.projection.landsDuringClosure
          ? `${formatDuration(e.projection.holdS)}, lands closed`
          : e.projection.holdS > 0
            ? formatDuration(e.projection.holdS)
            : 'None',
      ),
    },
    { label: 'Risk index (in flight)', ...cell((e) => `${formatInteger(e.risk.index)} of 100`) },
    {
      label: 'Wind and visibility on arrival',
      ...cell(
        (e) =>
          `${formatWind(e.projection.arrival).replace(' at ', ' ')}, ${e.projection.arrival.visibilityKm.toFixed(0)} km vis`,
      ),
    },
  ];
}

function Candidates({
  flight,
  aircraft,
  chosen,
  onPick,
}: {
  readonly flight: FlightView;
  readonly aircraft: AircraftState;
  readonly chosen: RoutePoint | null;
  readonly onPick: (place: RoutePoint) => void;
}) {
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const context = usePlanContext();
  const model = aircraft.performance;
  // Aerodromes are looked up around where the aircraft was when the panel opened: near enough.
  const near = useAsync(`near:${flight.id}:${flight.revisions.length}`, () =>
    loadAerodromesNear(flight.lat, flight.lon),
  );
  const ranked = useMemo(() => {
    if (near.status !== 'ready' || !model || !context) return null;
    const places = (near.value as AerodromeRow[]).map(aerodromePoint);
    return rankCandidates(model, flight, places, context);
  }, [near, model, context, flight]);

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Where to land</SectionLabel>
      {near.status === 'failed' && <Hint>Aerodromes could not be read: {near.error}</Hint>}
      {ranked === null && near.status !== 'failed' && <Hint>Working out where it can reach.</Hint>}
      {ranked !== null && ranked.length === 0 && (
        <Hint>No large or medium aerodrome is within range of the search. Find one by name.</Hint>
      )}
      {ranked !== null && ranked.length > 0 && (
        <ResultList>
          {ranked.map((candidate) => (
            <ListRow
              key={candidate.place.refId ?? candidate.place.name}
              icon={Plane}
              primary={candidate.place.name}
              secondary={
                candidate.estimate
                  ? `${formatKm(candidate.distanceM)} · arrives ${clock(epoch, candidate.estimate.projection.arrivalTick)} · lands with ${formatKg(candidate.estimate.projection.landingFuelKg)}${candidate.note ? ` · ${candidate.note}` : ''}`
                  : `${formatKm(candidate.distanceM)} · ${candidate.note ?? 'Cannot be used.'}`
              }
              code={candidate.place.code}
              active={chosen?.refId !== undefined && chosen.refId === candidate.place.refId}
              onSelect={() => {
                onPick(candidate.place);
              }}
            />
          ))}
        </ResultList>
      )}
      <AerodromePicker label="Find another aerodrome" onPick={onPick} />
      <Hint>
        Large and medium aerodromes near the aircraft, from the reference data, by the fuel it would
        land with. Those it cannot use are listed with the reason.
      </Hint>
    </section>
  );
}

function Waypoints({ draft }: { readonly draft: PlanDraft }) {
  const rows = draft.plan.points.map((point, index) => ({ point, index }));
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Route from here</SectionLabel>
      <DataTable<(typeof rows)[number]>
        caption="The rest of the route, in order"
        rows={rows}
        rowKey={(row) => `${row.index}:${row.point.name}`}
        columns={[
          { header: 'Point', numeric: true, cell: (row) => row.point.code ?? row.point.name },
          {
            header: 'Edit',
            align: 'right',
            cell: (row) => (
              <span className="flex justify-end">
                {row.index < rows.length - 1 && (
                  <IconButton
                    icon={Plus}
                    label={`Add a waypoint after ${row.point.name}`}
                    onClick={() => {
                      editDraft((current) => insertWaypoint(current, row.index));
                    }}
                  />
                )}
                {isEditablePoint(draft, row.index) && (
                  <IconButton
                    icon={Trash2}
                    label={`Remove ${row.point.name}`}
                    onClick={() => {
                      editDraft((current) => removeWaypoint(current, row.index));
                    }}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
      <Hint>
        Drag a waypoint on the map to move it, or the small handle on a leg to add one. What has
        been flown cannot be changed.
      </Hint>
    </section>
  );
}

export interface RevisionPanelProps {
  readonly aircraft: AircraftState;
  readonly flight: FlightView;
  readonly draft: PlanDraft;
  readonly revision: RevisionDraft;
}

/** Compares a change to the rest of a flight with how the flight stands, and sends it. */
export function RevisionPanel({ aircraft, flight, draft, revision }: RevisionPanelProps) {
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  const mission = useSimStore(
    (state) =>
      state.view?.missions.missions.find(
        (candidate) => candidate.id === flight.missionId && candidate.status === 'active',
      ) ?? null,
  );
  const context = usePlanContext();
  const sampled = useSampledFlight(flight);
  const model = aircraft.performance;
  const aborting = revision.abortMissionId !== null;
  const remainder = useMemo(
    () => (revision.abortContinue ? remainderOf(sampled) : draftRemainder(draft)),
    [revision.abortContinue, sampled, draft],
  );
  const destination = remainder.at(-1) ?? null;

  const before = useMemo(
    () => (model && context ? currentEstimate(model, sampled, context) : null),
    [model, context, sampled],
  );
  const proposal = useMemo(
    () => (model && context ? proposalEstimate(model, sampled, remainder, context) : null),
    [model, context, sampled, remainder],
  );
  if (!model || !before || !proposal) {
    return (
      <DetailPanel kicker={aircraft.id} title="Operations" onClose={cancelPlanning}>
        <Hint>Working out what the flight would come to.</Hint>
      </DetailPanel>
    );
  }

  const { evaluation } = proposal;
  const unchanged = evaluation.unchanged && !aborting;
  const affected = objectivesAffected(mission, destination, aborting);
  const title = aborting ? 'Abort mission' : TITLE[revision.intent];
  const origin = flight.points[0];
  const landingChoice = revision.abortContinue ? 'continue' : revision.intent;

  const choose = (place: RoutePoint) => {
    setDraft(revisionDraft(sampled, [place]));
  };
  const confirm = () => {
    if (aborting && revision.abortMissionId) {
      simClient.send({
        type: 'abortMission',
        missionId: revision.abortMissionId,
        landing: abortLanding(landingChoice, remainder),
      });
    } else {
      simClient.send({
        type: 'reviseFlight',
        aircraftId: aircraft.id,
        intent: revision.intent,
        points: remainder,
      });
    }
    cancelPlanning();
    select({ type: 'aircraft', id: aircraft.id });
  };
  const blocked = !revision.abortContinue && !evaluation.flyable;

  return (
    <DetailPanel
      kicker={`${aircraft.id} · in flight`}
      title={title}
      badges={<SimulatedBadge />}
      onClose={cancelPlanning}
    >
      {aborting && (
        <section className="flex flex-col gap-2.5">
          <Notice tone="warn" title="Aborting the mission ends it now">
            Objectives already complete stay complete. The rest fail as “Mission aborted.” The
            aircraft flies on and lands where you choose.
          </Notice>
          <SectionLabel>Where the aircraft lands</SectionLabel>
          <SegmentedControl<'continue' | 'return' | 'divert'>
            label="Where the aircraft lands after the abort"
            value={landingChoice === 'reroute' ? 'continue' : landingChoice}
            options={[
              { value: 'continue', label: 'Go on' },
              { value: 'return', label: 'Return' },
              { value: 'divert', label: 'Divert' },
            ]}
            onChange={(choice) => {
              if (choice === 'continue') {
                setRevision({ abortContinue: true });
                setDraft(revisionDraft(sampled, remainderOf(sampled)));
              } else if (choice === 'return' && origin) {
                setRevision({ abortContinue: false, intent: 'return' });
                setDraft(revisionDraft(sampled, [origin]));
              } else {
                setRevision({ abortContinue: false, intent: 'divert' });
              }
            }}
          />
        </section>
      )}

      {revision.intent === 'divert' && !revision.abortContinue && (
        <Candidates flight={sampled} aircraft={aircraft} chosen={destination} onPick={choose} />
      )}
      {revision.intent === 'reroute' && !aborting && <Waypoints draft={draft} />}

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Before and after</SectionLabel>
        <div className="grid grid-cols-2 gap-x-3 text-2xs tracking-label text-ink-muted uppercase">
          <span>As it stands</span>
          <span>After the change</span>
        </div>
        {/* A list, not a table: the side panel is too narrow for three columns of readings. */}
        <dl
          className="flex flex-col gap-2"
          aria-label="The flight as it stands, and as it would be after this change"
        >
          {comparison(epoch, before, revision.abortContinue ? before : proposal.estimate).map(
            (row) => (
              <div key={row.label} className="flex flex-col gap-0.5">
                <dt className="text-2xs tracking-label text-ink-muted uppercase">{row.label}</dt>
                <dd className="telemetry grid cursor-text grid-cols-2 gap-x-3 text-sm select-text">
                  <span className="text-ink-secondary">{row.before}</span>
                  <span className={row.after === row.before ? 'text-ink-secondary' : 'text-ink'}>
                    {row.after}
                  </span>
                </dd>
              </div>
            ),
          )}
        </dl>
        <Hint>
          Flown from where the aircraft is, through the simulated weather and known events, with the
          simulation&apos;s own flight model. Recalculated when the change is made. The risk index
          counts only what a decision in flight can change, and decides nothing.
        </Hint>
      </section>

      {affected.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Mission objectives this decides</SectionLabel>
          <ul className="flex flex-col gap-1.5">
            {affected.map(({ objective, effect }) => (
              <li key={objective.id} className="flex flex-col">
                <span className="text-sm text-ink">
                  {objective.id} · {objective.label}
                </span>
                <span className="text-xs text-ink-secondary">{effect}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!revision.abortContinue && evaluation.constraints.length > 0 && (
        <ConstraintList items={evaluation.constraints} />
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={Check}
          disabled={blocked || unchanged}
          title={
            blocked
              ? 'This route cannot be flown. See the reasons above.'
              : unchanged
                ? 'This is the route the aircraft is already flying.'
                : undefined
          }
          onClick={confirm}
        >
          {aborting ? 'Abort mission' : `Confirm ${title.toLowerCase()}`}
        </Button>
        <Button variant="ghost" onClick={cancelPlanning}>
          {aborting ? 'Keep the mission' : 'Leave the route as it is'}
        </Button>
      </div>
      {(blocked || unchanged) && (
        <Hint>
          {blocked
            ? 'Not available: this route cannot be flown, for the reasons above.'
            : revision.intent === 'divert'
              ? 'Choose an aerodrome to divert to.'
              : 'Not available yet: this is the route the aircraft is already flying. Change it first.'}
        </Hint>
      )}
    </DetailPanel>
  );
}
