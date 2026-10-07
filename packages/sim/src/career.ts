import {
  CAREER,
  NO_READINESS,
  NO_TOTALS,
  careerTotals,
  contributions,
  withContributions,
  withDay,
  withReadinessStep,
  type CareerDay,
  type CareerEntry,
  type CareerTotals,
} from '@aegis/domain';
import { CommandRejected } from './fleet';

/*
 * The career (ADR 0031): whether this world is one, the command day that is open, and the days
 * that have closed. The record is advanced by the entries the engine logs and by nothing else,
 * so a world replayed from its seed and its log arrives at the same record.
 */

export interface CareerSnapshot {
  /** The tick the world became a career; `null` for a world that is not one. */
  readonly establishedTick: number | null;
  /** The open command day; `null` before command is taken. */
  readonly day: CareerDay | null;
  /** Closed days, in order. Every one is kept. */
  readonly days: readonly CareerDay[];
}

export const EMPTY_CAREER: CareerSnapshot = { establishedTick: null, day: null, days: [] };

/** Commands that change the career itself. */
export type CareerCommand =
  /** Makes the world a career: from here it operates by itself (ADR 0030). */
  | { readonly type: 'beginCareer' }
  /** Opens the first command day. */
  | { readonly type: 'takeCommand' }
  /** Closes the open command day and opens the next at the same tick. */
  | { readonly type: 'endCommandDay' };

export const CAREER_COMMAND_TYPES: ReadonlySet<string> = new Set<CareerCommand['type']>([
  'beginCareer',
  'takeCommand',
  'endCommandDay',
]);

/** The career as the interface is given it. */
export interface CareerView {
  readonly establishedTick: number | null;
  /** The open command day. */
  readonly day: CareerDay | null;
  /** How many days have closed. */
  readonly closedDays: number;
  /** The most recent closed days, oldest first; at most `CAREER.recentDays`. */
  readonly recentDays: readonly CareerDay[];
  /** Every closed day summed. */
  readonly closedTotals: CareerTotals;
  /** Every day summed, the open one up to now. */
  readonly totals: CareerTotals;
  /** The earliest tick at which the open day may be ended; `null` when none is open. */
  readonly dayMayEndTick: number | null;
}

function assertDay(day: CareerDay, number: number, open: boolean): void {
  if (day.number !== number) throw new Error(`Saved career day ${day.number} is out of order`);
  if (!Number.isSafeInteger(day.startedTick) || day.startedTick < 0) {
    throw new Error(`Saved career day ${day.number} has an invalid start`);
  }
  if (
    open ? day.endedTick !== null : !(day.endedTick !== null && day.endedTick >= day.startedTick)
  ) {
    throw new Error(`Saved career day ${day.number} has an invalid end`);
  }
}

export class Career {
  private establishedTick: number | null;
  private day: CareerDay | null;
  private days: CareerDay[];
  /** The closed days summed. Kept so that the view does not add them up at every step. */
  private closedTotals: CareerTotals;

  constructor(snapshot: CareerSnapshot = EMPTY_CAREER) {
    snapshot.days.forEach((day, index) => {
      assertDay(day, index + 1, false);
      const previous = snapshot.days[index - 1];
      if (previous && previous.endedTick !== day.startedTick) {
        throw new Error(`Saved career day ${day.number} does not follow the day before`);
      }
    });
    if (snapshot.day) {
      assertDay(snapshot.day, snapshot.days.length + 1, true);
      const previous = snapshot.days.at(-1);
      if (previous && previous.endedTick !== snapshot.day.startedTick) {
        throw new Error('The open career day does not follow the day before');
      }
    }
    if (snapshot.establishedTick === null && (snapshot.day || snapshot.days.length > 0)) {
      throw new Error('Saved career has days but was never begun');
    }
    this.establishedTick = snapshot.establishedTick;
    this.day = snapshot.day;
    this.days = [...snapshot.days];
    this.closedTotals = careerTotals(this.days, 0);
  }

  get established(): boolean {
    return this.establishedTick !== null;
  }

  /**
   * Carries out a career command. Returns false when it changes nothing; throws
   * `CommandRejected` when it cannot be done.
   */
  apply(command: CareerCommand, tick: number): boolean {
    switch (command.type) {
      case 'beginCareer':
        if (this.establishedTick !== null) return false;
        this.establishedTick = tick;
        return true;
      case 'takeCommand':
        if (this.establishedTick === null) {
          throw new CommandRejected('This world is not a career. Begin one first.');
        }
        if (this.day !== null || this.days.length > 0) {
          throw new CommandRejected('Command has already been taken.');
        }
        this.day = this.open(1, tick);
        return true;
      case 'endCommandDay': {
        const day = this.day;
        if (day === null) throw new CommandRejected('There is no command day to end.');
        const mayEnd = day.startedTick + CAREER.minDayS;
        if (tick < mayEnd) {
          const minutes = Math.ceil((mayEnd - tick) / 60);
          throw new CommandRejected(
            `Day ${day.number} has only just begun. It can be ended in ${minutes} min of simulation time.`,
          );
        }
        const closed: CareerDay = { ...day, endedTick: tick };
        this.days.push(closed);
        this.closedTotals = withDay(this.closedTotals, closed, tick);
        this.day = this.open(day.number + 1, tick);
        return true;
      }
    }
  }

  private open(number: number, tick: number): CareerDay {
    return { number, startedTick: tick, endedTick: null, counters: {}, readiness: NO_READINESS };
  }

  /** Shows the record an entry the engine has just logged. Nothing is recorded outside a day. */
  observe(entry: CareerEntry): void {
    if (this.day === null) return;
    const counters = withContributions(this.day.counters, contributions(entry));
    if (counters !== this.day.counters) this.day = { ...this.day, counters };
  }

  /** One step of the open day: `ready` of `total` aircraft were available or flying. */
  step(ready: number, total: number): void {
    if (this.day === null) return;
    const readiness = withReadinessStep(this.day.readiness, ready, total);
    if (readiness !== this.day.readiness) this.day = { ...this.day, readiness };
  }

  snapshot(): CareerSnapshot {
    return { establishedTick: this.establishedTick, day: this.day, days: [...this.days] };
  }

  view(tick: number): CareerView {
    return {
      establishedTick: this.establishedTick,
      day: this.day,
      closedDays: this.days.length,
      recentDays: this.days.slice(-CAREER.recentDays),
      closedTotals: this.closedTotals,
      totals: this.day ? withDay(this.closedTotals, this.day, tick) : this.closedTotals,
      dayMayEndTick: this.day ? this.day.startedTick + CAREER.minDayS : null,
    };
  }
}

export { NO_TOTALS };
