import {
  derivePerformance,
  generatePlan,
  simInstant,
  suggestedFuelKg,
  type PerformanceModel,
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
): FleetCommand {
  const plan = generatePlan(model, origin, destination);
  const fuelKg = suggestedFuelKg(model, plan, payloadKg);
  if (fuelKg === null) throw new Error('Fixture route cannot be flown');
  return { type: 'launchFlight', aircraftId, plan, load: { fuelKg, payloadKg } };
}
