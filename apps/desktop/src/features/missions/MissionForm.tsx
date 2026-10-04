import {
  MISSION_PRIORITIES,
  MISSION_TEMPLATES,
  MISSION_TYPES,
  briefProblem,
  evaluateMission,
  newObjectives,
  type Mission,
  type MissionPriority,
  type MissionType,
} from '@aegis/domain';
import { MAINTENANCE_POLICY } from '@aegis/sim';
import {
  Button,
  ConstraintList,
  DataField,
  DataList,
  Hint,
  Notice,
  NumberField,
  PageHeader,
  Panel,
  SelectField,
  TextField,
} from '@aegis/ui';
import { Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatDuration, formatKg, formatKm } from '../../format';
import {
  PRIORITY_LABEL,
  blankForm,
  briefFromForm,
  configurationFromForm,
  formFromMission,
  suggestedTarget,
  type MissionFormValues,
} from '../../missions/mission-logic';
import { createMission, updateMission } from '../../missions/service';
import { NO_AIRCRAFT, useSimStore } from '../../state/sim-store';
import { AerodromePicker, placeName } from '../shared/fleet-display';
import { ObjectiveList, RiskBreakdown } from '../shared/mission-display';
import { usePlanContext } from '../shared/usePlanContext';
import { useStable } from '../shared/useStable';

export interface MissionFormProps {
  /** The mission being edited; `null` to create one. */
  readonly mission: Mission | null;
  readonly onDone: () => void;
}

/**
 * Creates or edits a mission: choose the type, say what it is for, assign an aircraft, and review
 * what the template makes of it. Inline, not a dialog, so the list stays in view.
 */
export function MissionForm({ mission, onDone }: MissionFormProps) {
  const fleet = useStable(useSimStore((state) => state.view?.fleet.aircraft ?? NO_AIRCRAFT));
  const tick = useSimStore((state) => {
    const now = state.view?.clock.tick ?? 0;
    return now - (now % 600);
  });
  // The simulation republishes the mission several times a second; hold on to one copy.
  const existing = useStable(mission);
  const [values, setValues] = useState<MissionFormValues>(() =>
    existing ? formFromMission(existing) : blankForm('training'),
  );
  const set = (change: Partial<MissionFormValues>) => {
    setValues((current) => ({ ...current, ...change }));
  };

  const template = MISSION_TEMPLATES[values.type];
  const aircraft = fleet.find((candidate) => candidate.id === values.aircraftId) ?? null;
  const flyable = fleet.filter((candidate) => candidate.performance !== null);
  const suitable = aircraft ? template.suitableCategories.includes(aircraft.category) : true;

  const chooseAircraft = (aircraftId: string) => {
    const chosen = fleet.find((candidate) => candidate.id === aircraftId) ?? null;
    const needsTarget = template.shape !== 'point_to_point' && values.target === null;
    set({
      aircraftId: chosen?.id ?? null,
      ...(needsTarget &&
        chosen?.location &&
        chosen.performance && {
          target: suggestedTarget(
            values.type,
            chosen.location,
            chosen.performance.referenceRangeKm,
          ),
        }),
    });
  };
  const chooseType = (type: MissionType) => {
    setValues((current) => ({
      ...blankForm(type),
      title: current.title,
      aircraftId: current.aircraftId,
      destination: current.destination,
      // A point chosen for one type is a sensible start for another of the same shape.
      target:
        MISSION_TEMPLATES[type].shape === 'point_to_point'
          ? null
          : (current.target ??
            (aircraft?.location && aircraft.performance
              ? suggestedTarget(type, aircraft.location, aircraft.performance.referenceRangeKm)
              : null)),
    }));
  };

  const stableValues = useStable(values);
  const context = usePlanContext();
  const preview = useMemo(() => {
    const configuration = configurationFromForm(stableValues, aircraft, tick, existing, context);
    const evaluation = evaluateMission({
      type: stableValues.type,
      aircraft,
      plan: configuration.plan,
      load: configuration.load,
      objectives: newObjectives(configuration.objectives),
      departureTick: tick,
      completeByTick: configuration.completeByTick,
      maintenance: MAINTENANCE_POLICY,
      stepS: 1,
      weather: context?.weather ?? null,
      ...(context?.hazards && { hazards: context.hazards }),
    });
    return { configuration, evaluation };
  }, [stableValues, aircraft, tick, existing, context]);
  const { configuration, evaluation } = preview;
  const incomplete = briefProblem(briefFromForm(values));
  const estimate = evaluation.plan?.estimate ?? null;

  const save = () => {
    if (mission) updateMission(mission, configuration);
    else createMission(values.type, configuration);
    onDone();
  };

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <PageHeader
        kicker={mission ? `Edit ${mission.id}` : 'New mission'}
        title={values.title.trim() || configuration.title}
        subtitle={template.description}
        actions={
          <>
            <Button variant="ghost" onClick={onDone}>
              Discard
            </Button>
            <Button variant="primary" icon={Save} onClick={save}>
              {configuration.plan ? 'Save as planned' : 'Save as draft'}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Mission">
          <div className="flex flex-col gap-3">
            <SelectField
              label="Type"
              value={values.type}
              options={MISSION_TYPES.map((type) => ({
                value: type,
                label: MISSION_TEMPLATES[type].label,
              }))}
              onChange={(type) => {
                // The type of an existing mission is fixed: it is what the mission is.
                if (!mission) chooseType(type as MissionType);
              }}
              {...(mission && { hint: 'The type of an existing mission cannot be changed.' })}
            />
            <TextField
              label="Title"
              value={values.title}
              placeholder={configuration.title}
              maxLength={80}
              onChange={(title) => {
                set({ title });
              }}
            />
            <SelectField
              label="Priority"
              value={values.priority}
              options={MISSION_PRIORITIES.map((priority) => ({
                value: priority,
                label: PRIORITY_LABEL[priority],
              }))}
              onChange={(priority) => {
                set({ priority: priority as MissionPriority });
              }}
            />
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Planned start"
                unit="h from now"
                min={0}
                step={0.5}
                value={values.startInHours}
                hint="For your own scheduling. 0 leaves it unset. The mission launches when you launch it."
                onChange={(startInHours) => {
                  set({ startInHours });
                }}
              />
              <NumberField
                label="Complete by"
                unit="h from now"
                min={0}
                step={0.5}
                value={values.deadlineInHours}
                hint="A deadline the mission is judged against. 0 keeps the current one, or none."
                onChange={(deadlineInHours) => {
                  set({ deadlineInHours });
                }}
              />
            </div>
          </div>
        </Panel>

        <Panel title="Aircraft">
          <div className="flex flex-col gap-3">
            <SelectField
              label="Assigned aircraft"
              placeholder="Choose an aircraft"
              value={values.aircraftId ?? ''}
              options={flyable.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.id} · ${candidate.typeName} · ${placeName(candidate.location)}`,
              }))}
              onChange={chooseAircraft}
            />
            {aircraft && (
              <DataList>
                <DataField label="Location" value={placeName(aircraft.location)} prose />
                <DataField label="Condition" value={`${aircraft.conditionPct.toFixed(1)} %`} />
              </DataList>
            )}
            {aircraft && !suitable && (
              <Notice tone="warn" title="Not the aircraft this template is meant for">
                It may fly the mission. The mismatch is counted in the risk.
              </Notice>
            )}
            {flyable.length === 0 && <Hint>No aircraft in the fleet can fly yet.</Hint>}
            <Hint>The mission starts from wherever the aircraft is.</Hint>
          </div>
        </Panel>

        <Panel title={template.shape === 'point_to_point' ? 'Destination' : 'Where'}>
          <div className="flex flex-col gap-3">
            {template.shape === 'point_to_point' ? (
              <>
                {values.destination && (
                  <DataField label="Selected" value={placeName(values.destination)} prose />
                )}
                <AerodromePicker
                  label="Find a destination aerodrome"
                  onPick={(destination) => {
                    set({ destination });
                  }}
                />
              </>
            ) : (
              <>
                <TextField
                  label={template.shape === 'orbit' ? 'Area name' : 'Point name'}
                  value={values.target?.name ?? ''}
                  maxLength={40}
                  onChange={(name) => {
                    set({ target: { lat: 0, lon: 0, ...values.target, name } });
                  }}
                />
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label="Latitude"
                    unit="°"
                    min={-85}
                    max={85}
                    step={0.1}
                    value={values.target?.lat ?? Number.NaN}
                    onChange={(lat) => {
                      set({ target: { name: 'Point', lon: 0, ...values.target, lat } });
                    }}
                  />
                  <NumberField
                    label="Longitude"
                    unit="°"
                    min={-180}
                    max={180}
                    step={0.1}
                    value={values.target?.lon ?? Number.NaN}
                    onChange={(lon) => {
                      set({ target: { name: 'Point', lat: 0, ...values.target, lon } });
                    }}
                  />
                </div>
                <AerodromePicker
                  label="Or use the position of an aerodrome"
                  onPick={(place) => {
                    set({ target: { name: place.name, lat: place.lat, lon: place.lon } });
                  }}
                />
                {template.shape === 'orbit' && (
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      label="Time in the area"
                      unit="min"
                      min={1}
                      step={5}
                      value={values.holdMinutes}
                      onChange={(holdMinutes) => {
                        set({ holdMinutes });
                      }}
                    />
                    <NumberField
                      label="Orbit radius"
                      unit="km"
                      min={5}
                      step={5}
                      value={values.orbitRadiusKm}
                      onChange={(orbitRadiusKm) => {
                        set({ orbitRadiusKm });
                      }}
                    />
                  </div>
                )}
                <Hint>
                  When an aircraft is chosen, a point 150 km north of it is suggested as a start.
                  The route can then be edited on the map.
                </Hint>
              </>
            )}
            {template.carriesPayload && (
              <NumberField
                label="Payload to deliver"
                unit="kg"
                min={0}
                step={500}
                value={values.payloadKg}
                hint="Total mass. No particular cargo is modelled."
                onChange={(payloadKg) => {
                  set({ payloadKg });
                }}
              />
            )}
            {incomplete && <Hint>{incomplete}</Hint>}
          </div>
        </Panel>

        <Panel title={evaluation.forecast ? 'Objectives (forecast)' : 'Objectives'}>
          <ObjectiveList
            objectives={evaluation.forecast?.objectives ?? newObjectives(configuration.objectives)}
            forecast={evaluation.forecast !== null}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Estimate">
          {estimate ? (
            <DataList>
              <DataField label="Distance" value={formatKm(estimate.distanceM)} />
              <DataField label="Flight time" value={formatDuration(estimate.durationS)} />
              <DataField label="Fuel used" value={formatKg(estimate.fuelUsedKg)} />
              <DataField label="Fuel on landing" value={formatKg(estimate.fuelAtDestinationKg)} />
            </DataList>
          ) : (
            <Hint>An estimate appears once the mission has an aircraft and somewhere to go.</Hint>
          )}
        </Panel>
        <Panel title="Risk">
          {evaluation.risk ? (
            <RiskBreakdown risk={evaluation.risk} />
          ) : (
            <Hint>Risk is assessed once the mission has an aircraft and a route.</Hint>
          )}
        </Panel>
      </div>

      {evaluation.constraints.length > 0 && (
        <Panel title="Constraints">
          <ConstraintList items={evaluation.constraints} />
        </Panel>
      )}
    </div>
  );
}
