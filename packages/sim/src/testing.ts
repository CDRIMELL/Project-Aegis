import {
  derivePerformance,
  generatePlan,
  simInstant,
  suggestedFuelKg,
  type PerformanceModel,
  type PlanContext,
  type RoutePoint,
  type TypeCharacteristics,
} from '@aegis/domain';
import type { AircraftOrder, FleetCommand } from './fleet';
import type { HostClock } from './runner';
import type { Checkpoint, WorldStore } from './world';

/** Host clock moved by hand, for tests of anything driven by a {@link HostClock}. */
export class ManualHostClock implements HostClock {
  private monotonic = 0;
  private wall: number;

  constructor(wallStartMs = 1_800_000_000_000) {
    this.wall = wallStartMs;
  }

  elapse(ms: number): void {
    this.monotonic += ms;
    this.wall += ms;
  }

  monotonicMs(): number {
    return this.monotonic;
  }

  wallMs(): number {
    return this.wall;
  }
}

/** Checkpoints are plain data, so a JSON round trip is a faithful deep copy. */
function copyOf(checkpoint: Checkpoint): Checkpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
}

/** In-memory {@link WorldStore} that records every save and can be made slow or failing. */
export class MemoryWorldStore implements WorldStore {
  readonly saves: Checkpoint[] = [];
  /** Number of `save` calls currently awaiting completion. */
  inFlight = 0;
  maxInFlight = 0;
  failNext: Error | null = null;
  /** When set, each save waits for this gate before completing. */
  gate: Promise<void> | null = null;

  constructor(private current: Checkpoint | null = null) {}

  load(): Promise<Checkpoint | null> {
    return Promise.resolve(this.current ? copyOf(this.current) : null);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) {
        await this.gate;
      }
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        throw error;
      }
      const copy = copyOf(checkpoint);
      this.current = copy;
      this.saves.push(copy);
    } finally {
      this.inFlight -= 1;
    }
  }

  get latest(): Checkpoint | null {
    return this.current;
  }
}

const fixtureModel = (type: TypeCharacteristics): PerformanceModel => {
  const result = derivePerformance(type);
  if (!result.available) throw new Error(`Fixture type has no model: ${result.missing.join(', ')}`);
  return result.model;
};

const fixtureAerodrome = (
  code: string,
  name: string,
  lat: number,
  lon: number,
  elevationM: number,
): RoutePoint => ({
  kind: 'aerodrome',
  refId: `fixture:${code.toLowerCase()}`,
  name,
  code,
  lat,
  lon,
  elevationM,
});

/** Aircraft and places for tests. Characteristics are illustrative test inputs, not reference data. */
export const FIXTURES = {
  epoch: simInstant(Date.UTC(2026, 9, 4, 12, 0, 0)),
  models: {
    fastJet: fixtureModel({
      category: 'fast_jet',
      engineType: 'turbofan',
      emptyMassKg: 11000,
      maxTakeoffMassKg: 23500,
      cruiseSpeedKmh: null,
      maxSpeedKmh: 2495,
      rangeKm: 2900,
      ferryRangeKm: 3790,
      serviceCeilingM: 16764,
    }),
    transport: fixtureModel({
      category: 'transport',
      engineType: 'turbofan',
      emptyMassKg: 128140,
      maxTakeoffMassKg: 265352,
      cruiseSpeedKmh: 833,
      maxSpeedKmh: null,
      rangeKm: 4482,
      ferryRangeKm: 11538,
      serviceCeilingM: 13716,
    }),
  },
  places: {
    prestwick: fixtureAerodrome('EGPK', 'Glasgow Prestwick', 55.5094, -4.5867, 20),
    newquay: fixtureAerodrome('EGHQ', 'Newquay', 50.4406, -4.9954, 119),
    exeter: fixtureAerodrome('EGTE', 'Exeter', 50.7344, -3.4139, 31),
    akrotiri: fixtureAerodrome('LCRA', 'Akrotiri', 34.5904, 32.9879, 23),
  },
} as const;

export function fixtureOrder(kind: keyof typeof FIXTURES.models, home: RoutePoint): AircraftOrder {
  return kind === 'fastJet'
    ? {
        typeId: 'fixture:fast-jet',
        typeName: 'Fixture fast jet',
        category: 'fast_jet',
        performance: FIXTURES.models.fastJet,
        performanceMissing: [],
        home,
      }
    : {
        typeId: 'fixture:transport',
        typeName: 'Fixture transport',
        category: 'transport',
        performance: FIXTURES.models.transport,
        performanceMissing: [],
        home,
      };
}

/** A launch command for the direct route, with fuel to arrive on reserve. */
export function fixtureLaunch(
  aircraftId: string,
  model: PerformanceModel,
  origin: RoutePoint,
  destination: RoutePoint,
  payloadKg = 0,
  /** The world the flight will leave in, so that its fuel allows for the weather. */
  context: PlanContext | null = null,
): Extract<FleetCommand, { type: 'launchFlight' }> {
  const plan = generatePlan(model, origin, destination);
  const fuelKg = suggestedFuelKg(model, plan, payloadKg, context);
  if (fuelKg === null) throw new Error('Fixture route cannot be flown');
  return { type: 'launchFlight', aircraftId, plan, load: { fuelKg, payloadKg } };
}

/** What the helpers below need of an engine. */
interface Steppable {
  applyCommand(command: FleetCommand): boolean;
  runSteps(steps: number): void;
  snapshot(): { readonly fleet: { readonly aircraft: readonly { id: string; status: string }[] } };
}

/** Runs the world until an aircraft is no longer being serviced on the ground (ADR 0027). */
export function untilServiced(engine: Steppable, aircraftId: string, limitS = 4 * 3600): void {
  const servicing = () =>
    engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === aircraftId)?.status ===
    'servicing';
  for (let elapsed = 0; servicing(); elapsed++) {
    if (elapsed > limitS) throw new Error(`${aircraftId} was still being serviced`);
    engine.runSteps(1);
  }
}

/**
 * Brings an aircraft's fuel, and its payload if one is given, to a quantity and runs the world
 * until that is done: what an operator does before a launch, now that both take time to load.
 */
export function fuelled(
  engine: Steppable,
  aircraftId: string,
  fuelKg: number,
  /** The payload to have aboard as well; left as it is when not given. */
  payloadKg?: number,
): void {
  untilServiced(engine, aircraftId);
  const status = engine.snapshot().fleet.aircraft.find((each) => each.id === aircraftId)?.status;
  // Anything else cannot be fuelled, and the launch that follows says why it cannot go.
  if (status !== 'available') return;
  engine.applyCommand({
    type: 'serviceAircraft',
    aircraftId,
    fuelKg,
    ...(payloadKg !== undefined && { payloadKg }),
  });
  untilServiced(engine, aircraftId);
}

/** What the helpers below need of an engine. */
interface Launching extends Steppable {
  snapshot(): {
    readonly fleet: { readonly aircraft: readonly { id: string; status: string }[] };
    readonly missions: {
      readonly missions: readonly { id: string; aircraftId: string | null }[];
    };
  };
  applyCommand(command: never): boolean;
}

/** Launches a flight once the fuel it departs with has been loaded. */
export function launchFuelled(
  engine: Steppable,
  command: Extract<FleetCommand, { type: 'launchFlight' }>,
): boolean {
  fuelled(engine, command.aircraftId, command.load.fuelKg, command.load.payloadKg);
  return engine.applyCommand(command);
}

/** Launches an accepted mission once its aircraft has been prepared. */
export function launchMissionWhenReady(engine: Launching, missionId: string): boolean {
  const aircraftId = engine
    .snapshot()
    .missions.missions.find((mission) => mission.id === missionId)?.aircraftId;
  if (aircraftId) untilServiced(engine, aircraftId);
  return engine.applyCommand({ type: 'launchMission', missionId } as never);
}

/**
 * A launch command for the direct route with the tanks as full as they are when an aircraft is
 * acquired: a flight that needs no fuelling first, for tests that are about something else.
 */
export function fixtureLaunchFull(
  aircraftId: string,
  model: PerformanceModel,
  origin: RoutePoint,
  destination: RoutePoint,
  payloadKg = 0,
): Extract<FleetCommand, { type: 'launchFlight' }> {
  return {
    type: 'launchFlight',
    aircraftId,
    plan: generatePlan(model, origin, destination),
    load: { fuelKg: model.fuelCapacityKg, payloadKg },
  };
}

/** Advances a runner's world, in slices of real time, until an aircraft is no longer serviced. */
export function advanceUntilServiced(
  runner: {
    advance(): void;
    view(): { readonly fleet: { readonly aircraft: readonly { id: string; status: string }[] } };
  },
  host: ManualHostClock,
  aircraftId: string,
  sliceMs = 100,
): void {
  const servicing = () =>
    runner.view().fleet.aircraft.find((aircraft) => aircraft.id === aircraftId)?.status ===
    'servicing';
  for (let slices = 0; servicing(); slices++) {
    if (slices > 1_000_000) throw new Error(`${aircraftId} was still being serviced`);
    host.elapse(sliceMs);
    runner.advance();
  }
}
