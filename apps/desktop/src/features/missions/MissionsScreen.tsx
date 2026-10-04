import { MISSION_TEMPLATES, MISSION_TYPES, type Mission, type MissionType } from '@aegis/domain';
import { Button, EmptyState, EntityRow, Hint, ListPane, Notice, SelectField } from '@aegis/ui';
import { Plus, Route } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { formatDuration } from '../../format';
import {
  GROUP_LABEL,
  dueTick,
  groupOf,
  listMissions,
  missionProgress,
  routeSummary,
  type MissionFilter,
  type MissionGroup,
  type MissionSort,
} from '../../missions/mission-logic';
import { useSimStore } from '../../state/sim-store';
import { MissionStatusBadge } from '../shared/mission-display';
import { MissionDetail } from './MissionDetail';
import { MissionForm } from './MissionForm';

const GROUPS: readonly MissionGroup[] = ['offers', 'planned', 'active', 'history'];
const SORTS: readonly { value: MissionSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'priority', label: 'Priority' },
  { value: 'deadline', label: 'Soonest due' },
];

/** The second line of a list row: who flies it, where, and what is due or how far along it is. */
function rowDetail(mission: Mission, tick: number): string {
  const parts = [mission.aircraftId ?? 'No aircraft', routeSummary(mission)];
  if (mission.status === 'active') {
    parts.push(`${Math.round(missionProgress(mission) * 100)} %`);
  } else if (mission.outcome) {
    parts.push(
      `${mission.outcome.objectivesComplete}/${mission.outcome.objectivesRequired} objectives`,
    );
  } else {
    const due = dueTick(mission);
    if (due !== null && groupOf(mission.status) !== 'history') {
      const left = due - tick;
      parts.push(
        left >= 0
          ? `${mission.status === 'offered' ? 'answer' : 'due'} in ${formatDuration(left)}`
          : 'overdue',
      );
    }
  }
  return parts.join(' · ');
}

/** Missions: what the player has planned, what is flying, what the world offers, and what is done. */
export function MissionsScreen() {
  const missions = useSimStore((state) => state.view?.missions.missions ?? null);
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const operatingArea = useSimStore((state) => state.view?.missions.operatingAreaSize ?? 0);
  const rejection = useSimStore((state) => state.rejection);
  const { missionId, mode } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MissionFilter>({
    group: 'all',
    type: 'all',
    sort: 'newest',
  });

  const all = missions ?? [];
  const shown = listMissions(all, filter);
  const creating = missionId === 'new';
  const selected = creating
    ? null
    : (all.find((candidate) => candidate.id === missionId) ?? shown[0] ?? null);
  const editing = !creating && mode === 'edit' && selected !== null;
  const count = (group: MissionGroup) =>
    all.filter((mission) => groupOf(mission.status) === group).length;

  return (
    <div className="flex size-full">
      <ListPane
        title={`Missions (${all.length})`}
        action={
          <Button
            size="sm"
            icon={Plus}
            onClick={() => {
              void navigate('/missions/new');
            }}
          >
            New mission
          </Button>
        }
      >
        <div className="flex flex-col gap-2 border-b border-line-subtle px-3 pt-2 pb-3">
          <SelectField
            label="Show"
            value={filter.group}
            options={[
              { value: 'all', label: `All (${all.length})` },
              ...GROUPS.map((group) => ({
                value: group,
                label: `${GROUP_LABEL[group]} (${count(group)})`,
              })),
            ]}
            onChange={(group) => {
              setFilter((current) => ({ ...current, group: group as MissionFilter['group'] }));
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Mission type"
              value={filter.type}
              options={[
                { value: 'all', label: 'All types' },
                ...MISSION_TYPES.map((type) => ({
                  value: type,
                  label: MISSION_TEMPLATES[type].label,
                })),
              ]}
              onChange={(type) => {
                setFilter((current) => ({ ...current, type: type as MissionType | 'all' }));
              }}
            />
            <SelectField
              label="Order"
              value={filter.sort}
              options={SORTS}
              onChange={(sort) => {
                setFilter((current) => ({ ...current, sort: sort as MissionSort }));
              }}
            />
          </div>
        </div>
        {shown.map((mission) => (
          <EntityRow
            key={mission.id}
            code={mission.id}
            primary={mission.title}
            secondary={rowDetail(mission, tick)}
            badge={<MissionStatusBadge status={mission.status} />}
            active={!creating && mission.id === selected?.id}
            onSelect={() => {
              void navigate(`/missions/${mission.id}`);
            }}
          />
        ))}
        {all.length > 0 && shown.length === 0 && (
          <div className="px-3 py-3">
            <Hint>No mission matches these filters.</Hint>
          </div>
        )}
      </ListPane>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {rejection && (
            <Notice tone="warn" title="The last command was refused">
              {rejection}
            </Notice>
          )}
          {creating ? (
            <MissionForm
              mission={null}
              onDone={() => {
                void navigate('/missions');
              }}
            />
          ) : editing ? (
            <MissionForm
              key={selected.id}
              mission={selected}
              onDone={() => {
                void navigate(`/missions/${selected.id}`);
              }}
            />
          ) : selected ? (
            <MissionDetail
              key={selected.id}
              mission={selected}
              onEdit={() => {
                void navigate(`/missions/${selected.id}/edit`);
              }}
            />
          ) : all.length > 0 ? (
            <EmptyState icon={Route} title="No mission matches these filters">
              {all.length === 1 ? 'There is 1 mission' : `There are ${all.length} missions`}, hidden
              by the filters on the left. Set "Show" to All and "Mission type" to All types to see
              {all.length === 1 ? ' it.' : ' them.'}
            </EmptyState>
          ) : (
            <EmptyState icon={Route} title="No missions yet">
              Create a mission, or let the simulation run: the world offers opportunities from time
              to time
              {operatingArea === 0 ? ', once it has an operating area.' : '.'}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
