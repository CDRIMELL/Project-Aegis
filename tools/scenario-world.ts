/*
 * Builds a saved world in which something specific is happening, for verifying the application
 * by hand or in a release build: an aircraft bound for a destination the world has just announced
 * it will close, one flying with a technical caution showing, or one that has just landed and is
 * in its post-flight checks.
 *
 * Nothing is injected. The world is given the starter fleet exactly as the application gives it,
 * and is run forward from a seed, with ordinary commands, until its own seeded events produce the
 * situation. It is then saved. So the result replays from its seed and its log like any other
 * world, and `npm run verify:world` passes on it.
 *
 *   npx tsx tools/scenario-world.ts closure <database>
 *   npx tsx tools/scenario-world.ts caution <database>
 *   npx tsx tools/scenario-world.ts turnaround <database>
 *
 * The database must hold reference data and no world yet:
 *   npm run data:install-pack -- --db <database>
 */
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import { generatePlan, simInstant, type RoutePoint } from '@aegis/domain';
import { SimulationEngine } from '@aegis/sim';
import { fuelled, untilServiced } from '@aegis/sim/testing';
import {
  aerodromePoint,
  buildCatalogue,
  starterOrders,
  type AerodromeRow,
} from '../apps/desktop/src/fleet/catalogue';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAircraftTypes,
} from '../apps/desktop/src/reference/queries';

const [kind, path] = process.argv.slice(2);
if ((kind !== 'closure' && kind !== 'caution' && kind !== 'turnaround') || !path) {
  console.error('usage: scenario-world.ts <closure|caution|turnaround> <database>');
  process.exit(2);
}

const database = openNodeDatabase(path);
bindReferenceDb(database.db);
const store = new SqliteWorldStore(database.db);
if ((await store.load()) !== null) {
  console.error(
    `${path} already holds a world; this tool only writes into a database without one.`,
  );
  process.exit(2);
}

async function aerodrome(icao: string): Promise<AerodromeRow> {
  const row = await loadAerodrome({ icao });
  if (!row) throw new Error(`${icao} is not in the reference data of ${path}`);
  return row;
}

/** The A400M of the starter fleet, based at Newquay. */
const AIRCRAFT = 'AEGIS-TR-001';
const HOUR = 3600;
const epoch = simInstant(Date.UTC(2026, 9, 5, 6, 0, 0));
const { types, attributes } = await loadAircraftTypes();
const homes = [await aerodrome('EGPK'), await aerodrome('EGHQ')];
const { orders, missing } = starterOrders(buildCatalogue(types, attributes), homes);
if (missing.length > 0) throw new Error(`The reference data lacks ${missing.join(', ')}`);
const newquay: RoutePoint = aerodromePoint(homes[1] as AerodromeRow);
const akrotiri: RoutePoint = aerodromePoint(await aerodrome('LCRA'));
const exeter: RoutePoint = aerodromePoint(await aerodrome('EGTE'));

function attempt(seed: string): SimulationEngine | null {
  const engine = SimulationEngine.create({ seed, epoch });
  engine.applyCommand({ type: 'seedStarterFleet', aircraft: orders });
  // A small operating area, so that when the world closes an aerodrome it is often this one.
  engine.applyCommand({ type: 'setOperatingArea', places: [akrotiri, exeter] });
  const aircraft = () => {
    const found = engine.snapshot().fleet.aircraft.find((each) => each.id === AIRCRAFT);
    if (!found) throw new Error('no aircraft');
    return found;
  };
  for (let leg = 0; leg < 8; leg++) {
    // Turned round after the last leg, and fuelled for this one: both take simulated time.
    untilServiced(engine, AIRCRAFT);
    const at = aircraft();
    const model = at.performance;
    if (at.status !== 'available' || !at.location || !model) return null;
    const to = at.location.code === 'EGHQ' ? akrotiri : newquay;
    fuelled(engine, AIRCRAFT, Math.min(46_000, model.fuelCapacityKg));
    try {
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: AIRCRAFT,
        plan: generatePlan(model, at.location, to),
        load: { fuelKg: Math.min(46_000, model.fuelCapacityKg), payloadKg: 0 },
      });
    } catch {
      // The destination is already known to be closed on arrival, or the origin is closed.
      engine.runSteps(3 * HOUR);
      continue;
    }
    for (let i = 0; i < 3000; i++) {
      const flight = engine.snapshot().fleet.flights.find((each) => each.status === 'active');
      if (!flight) {
        // Saved two minutes after a landing that began a turnaround: the checks are under way.
        if (kind === 'turnaround' && aircraft().service?.reason === 'turnaround') {
          engine.runSteps(120 - (engine.clock.tick - (aircraft().service?.startedTick ?? 0)));
          return engine;
        }
        break;
      }
      if (kind === 'caution' && flight.caution) return engine;
      if (kind === 'closure') {
        // Saved when the world announces that the destination will be closed at the time the
        // aircraft is due there, while it is still in the cruise with its decisions ahead of it.
        const view = engine.fleetView().activeFlights[0];
        const closing = engine
          .snapshot()
          .events.events.find(
            (event) =>
              event.type === 'aerodrome_closure' &&
              event.status !== 'resolved' &&
              event.place?.refId === to.refId,
          );
        if (
          closing &&
          view?.phase === 'cruise' &&
          view.etaTick >= closing.startTick &&
          view.etaTick < closing.endTick
        ) {
          return engine;
        }
      }
      engine.runSteps(20);
    }
    engine.runSteps(HOUR);
  }
  return null;
}

function search(): { engine: SimulationEngine; seed: string } | null {
  for (let n = 1; n <= 400; n++) {
    const seed = `${kind}-scenario-${n}`;
    const engine = attempt(seed);
    if (engine) return { engine, seed };
  }
  return null;
}

const found = search();
if (!found) {
  console.error(`no seed produced a ${kind} scenario`);
  process.exit(1);
}

const snapshot = found.engine.snapshot();
// Paused, so that it is as it was saved when the application opens it.
await store.save({
  seq: 1,
  wallTimeMs: Date.now(),
  snapshot: { ...snapshot, clock: { ...snapshot.clock, running: false } },
});
const flight = snapshot.fleet.flights.find((each) => each.status === 'active');
console.log(
  JSON.stringify(
    {
      scenario: kind,
      database: path,
      seed: found.seed,
      tick: snapshot.clock.tick,
      flight: flight?.id,
      to: flight?.plan.points.at(-1)?.code,
      aircraft: snapshot.fleet.aircraft
        .filter((each) => each.id === AIRCRAFT)
        .map((each) => `${each.id} ${each.status} at ${each.location?.code ?? 'airborne'}`),
      service: snapshot.fleet.aircraft.find((each) => each.id === AIRCRAFT)?.service ?? null,
      caution: flight?.caution ?? null,
      openEvents: snapshot.events.events
        .filter((event) => event.status !== 'resolved')
        .map(
          (event) =>
            `${event.id} ${event.type} ${event.status} ${event.startTick}-${event.endTick}`,
        ),
    },
    null,
    2,
  ),
);
database.close();
