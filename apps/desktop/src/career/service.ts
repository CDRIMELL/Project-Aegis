import type { SimView } from '@aegis/sim';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { focusFleet } from '../map/flight-binding';
import { backupBeforeNewCareer } from '../platform/tauri';
import { forgetReports } from '../reports/report-service';
import { simClient } from '../sim/client';
import { cancelPlanning } from '../state/plan-store';
import { setSession, useSessionStore } from '../state/session-store';
import { simWorldReplacing, useSimStore } from '../state/sim-store';
import { careerEpochMs, preludeSteps } from './brief-logic';

/*
 * Starting, continuing and leaving a career (ADR 0031). This is orchestration only: it asks the
 * worker for a world, waits for the application's own services to give that world its fleet and
 * its operating area, and issues the career's commands. Every rule is the simulation's.
 */

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Resolves with the first published view that satisfies `ready`; rejects if none does in time. */
function viewWhen(
  ready: (view: SimView) => boolean,
  timeoutMs: number,
  what: string,
): Promise<SimView> {
  return new Promise<SimView>((resolve, reject) => {
    const check = (): boolean => {
      const state = useSimStore.getState();
      if (state.phase === 'failed') {
        finish();
        reject(new Error(state.failure ?? 'The simulation stopped.'));
        return true;
      }
      if (state.view && ready(state.view)) {
        finish();
        resolve(state.view);
        return true;
      }
      return false;
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`Timed out waiting for ${what}.`));
    }, timeoutMs);
    const unsubscribe = useSimStore.subscribe(() => {
      check();
    });
    function finish(): void {
      clearTimeout(timeout);
      unsubscribe();
    }
    check();
  });
}

/**
 * Makes a new career: a new world, its fleet and operating area, and the hours it has already
 * been running when command is offered. An existing world is copied to the backups folder by the
 * native core before it is replaced. Resolves true when the briefing can be shown.
 */
export async function startNewCareer(): Promise<boolean> {
  if (useSessionStore.getState().creating) return false;
  setSession({ creating: { step: 'Preparing', share: null }, error: null, backupFile: null });
  try {
    if (useSimStore.getState().view) {
      setSession({ creating: { step: 'Keeping a copy of the current career', share: null } });
      simClient.leave();
      await simClient.flush(5000);
      const backup = await backupBeforeNewCareer();
      setSession({ backupFile: backup.fileName });
    }
    // Nothing read or drafted for the old world carries over to the new one.
    forgetReports();
    cancelPlanning();
    simWorldReplacing();

    setSession({ creating: { step: 'Creating the world', share: null } });
    const seed = simClient.create(careerEpochMs(Date.now()));
    await viewWhen((view) => view.seed === seed, 30_000, 'the new world');

    // The application's services give a new world its fleet and its operating area.
    setSession({ creating: { step: 'Assembling the fleet', share: null } });
    await viewWhen(
      (view) =>
        view.seed === seed &&
        view.fleet.starterFleetSeeded &&
        view.fleet.aircraft.length > 0 &&
        view.missions.operatingAreaSize > 0,
      180_000,
      'the fleet and its operating area',
    );

    // From here the world operates by itself. It is run through the hours before command is
    // offered: ordinary steps, with the clock itself left paused until command is taken.
    simClient.send({ type: 'pause' });
    simClient.send({ type: 'beginCareer' });
    const steps = preludeSteps(seed);
    setSession({ creating: { step: 'Running the hours before you arrive', share: 0 } });
    await simClient.run(steps, (share) => {
      setSession({ creating: { step: 'Running the hours before you arrive', share } });
    });
    await viewWhen(
      (view) => view.seed === seed && view.clock.tick >= steps,
      30_000,
      'the world to be ready',
    );
    setSession({ creating: null });
    return true;
  } catch (error) {
    setSession({ creating: null, error: describe(error) });
    return false;
  }
}

/**
 * Takes or resumes command of the open world. A world that is not yet a career becomes one here,
 * and a career that has no command day has its first opened.
 */
export function takeCommand(): void {
  const view = useSimStore.getState().view;
  if (!view) return;
  if (view.career.establishedTick === null) simClient.send({ type: 'beginCareer' });
  if (view.career.day === null) simClient.send({ type: 'takeCommand' });
  simClient.enter();
  simClient.send({ type: 'resume' });
  setSession({ stage: 'command', error: null });
  // The commander arrives looking at the operation, not at the whole world.
  focusFleet();
}

/**
 * Ends the open command day. Resolves with the number of the day that closed, or `null` when
 * the simulation refused; the reason is then in the simulation store.
 */
export async function endCommandDay(): Promise<number | null> {
  const before = useSimStore.getState().view;
  if (!before?.career.day) return null;
  const closing = before.career.day.number;
  simClient.send({ type: 'endCommandDay' });
  try {
    const refused = Symbol('refused');
    const outcome = await Promise.race([
      viewWhen((view) => view.career.closedDays >= closing, 10_000, 'the day to close'),
      new Promise<typeof refused>((resolve) => {
        const unsubscribe = useSimStore.subscribe((state) => {
          if (state.rejection !== null) {
            unsubscribe();
            resolve(refused);
          }
        });
        setTimeout(unsubscribe, 10_000);
      }),
    ]);
    if (outcome === refused) return null;
  } catch {
    return null;
  }
  // The world waits while the day is summed up and the next one briefed.
  simClient.send({ type: 'pause' });
  simClient.leave();
  await simClient.flush();
  setSession({ stage: 'front' });
  return closing;
}

/** Leaves the world for the menu. It stops where it is, and is saved. */
export async function leaveToMenu(): Promise<void> {
  simClient.leave();
  await simClient.flush();
  setSession({ stage: 'front' });
}

/** Saves and closes the application. */
export async function exitApplication(): Promise<void> {
  simClient.leave();
  await simClient.flush();
  await getCurrentWindow().destroy();
}
