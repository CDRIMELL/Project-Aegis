import {
  MISSION_TEMPLATES,
  formatUtc,
  type Mission,
  type MissionPriority,
  type MissionStatus,
  type Objective,
  type RiskAssessment,
  type SimInstant,
} from '@aegis/domain';
import { Hint, Meter, StatusBadge, type StatusTone } from '@aegis/ui';
import { formatDuration } from '../../format';
import { PRIORITY_LABEL, STATUS_LABEL, tickInstant } from '../../missions/mission-logic';

const STATUS_TONE: Readonly<Record<MissionStatus, StatusTone>> = {
  offered: 'info',
  draft: 'neutral',
  planned: 'neutral',
  accepted: 'info',
  active: 'ok',
  completed: 'ok',
  failed: 'critical',
  cancelled: 'neutral',
  rejected: 'neutral',
  expired: 'neutral',
};

export function MissionStatusBadge({ status }: { readonly status: MissionStatus }) {
  return <StatusBadge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusBadge>;
}

const PRIORITY_TONE: Readonly<Record<MissionPriority, StatusTone>> = {
  routine: 'neutral',
  priority: 'info',
  urgent: 'warn',
};

export function PriorityBadge({ priority }: { readonly priority: MissionPriority }) {
  return <StatusBadge tone={PRIORITY_TONE[priority]}>{PRIORITY_LABEL[priority]}</StatusBadge>;
}

/** Says where a mission came from: the player, or the simulated world. */
export function SourceBadge({ mission }: { readonly mission: Mission }) {
  return (
    <StatusBadge tone="ok">
      {mission.source === 'generated' ? 'Simulated opportunity' : 'Simulated'}
    </StatusBadge>
  );
}

export function typeLabel(mission: Mission): string {
  return MISSION_TEMPLATES[mission.type].label;
}

/** A tick as simulated UTC, `2026-10-04 14:05`, or `null` when there is no tick. */
export function formatTick(epoch: SimInstant | null, tick: number | null): string | null {
  if (epoch === null || tick === null) return null;
  return formatUtc(tickInstant(epoch, tick)).slice(0, 16).replace('T', ' ');
}

/** How long until a tick, or how long ago it was. */
export function relativeTick(now: number, tick: number | null): string | null {
  if (tick === null) return null;
  const delta = tick - now;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

const OBJECTIVE_STATE = {
  pending: { tone: 'info', word: 'Pending' },
  complete: { tone: 'ok', word: 'Complete' },
  failed: { tone: 'critical', word: 'Failed' },
} as const;

/** One objective: what it asks, how far along it is, and why it failed if it did. */
export function ObjectiveRow({ objective }: { readonly objective: Objective }) {
  const state = OBJECTIVE_STATE[objective.status];
  return (
    <li className="flex flex-col gap-1">
      <Meter
        label={`${objective.id} · ${objective.required ? 'Required' : 'Optional'}`}
        value={objective.status === 'complete' ? 1 : objective.progress}
        reading={state.word}
        tone={state.tone}
      />
      <span className="cursor-text text-xs text-ink-secondary select-text">{objective.label}</span>
      {objective.remark && <Hint>{objective.remark}</Hint>}
    </li>
  );
}

export function ObjectiveList({ objectives }: { readonly objectives: readonly Objective[] }) {
  if (objectives.length === 0) return <Hint>No objectives yet.</Hint>;
  return (
    <ul className="flex flex-col gap-3">
      {objectives.map((objective) => (
        <ObjectiveRow key={objective.id} objective={objective} />
      ))}
    </ul>
  );
}

/** The risk index with every contributor and the reason for its value. */
export function RiskBreakdown({ risk }: { readonly risk: RiskAssessment }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="telemetry text-2xl font-medium text-ink">{risk.index}</span>
        <span className="text-xs text-ink-muted">of 100 · simulation index</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {risk.contributors.map((contributor) => (
          <li key={contributor.id} className="flex flex-col gap-1">
            <Meter
              label={contributor.label}
              value={contributor.value}
              reading={`+${contributor.points.toFixed(0)}`}
              tone={
                contributor.value >= 0.66 ? 'critical' : contributor.value >= 0.33 ? 'warn' : 'info'
              }
            />
            <span className="cursor-text text-xs text-ink-secondary select-text">
              {contributor.explanation}
            </span>
          </li>
        ))}
      </ul>
      <Hint>
        The index explains this plan from the factors above. It does not decide the outcome, and it
        is not a measure of real-world risk.
      </Hint>
    </div>
  );
}
