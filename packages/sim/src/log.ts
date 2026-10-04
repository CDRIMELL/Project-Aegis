/*
 * The command and event log (ADR 0018).
 *
 * An append-only record of every action that changed the world and everything the world did in
 * response. The engine assigns the sequence; nothing here reads a clock.
 */

/** How many persisted entries the engine keeps in memory for display. The database holds them all. */
export const RECENT_LOG = 200;

export const LOG_KINDS = ['command', 'event'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

/**
 * - `player`: a command the player issued.
 * - `system`: a command the application issued itself (starter fleet, operating area, migration).
 * - `world`: an event produced by the simulation stepping.
 */
export const LOG_ACTORS = ['player', 'system', 'world'] as const;
export type LogActor = (typeof LOG_ACTORS)[number];

/** Plain JSON data. A command entry's payload is the whole command, enough to replay it. */
export type LogPayload = Readonly<Record<string, unknown>>;

export interface LogEntry {
  /** 1, 2, 3, ... with no gaps, in the order things happened. */
  readonly seq: number;
  /** The step boundary at which it happened. */
  readonly tick: number;
  readonly kind: LogKind;
  /** The command's type, or the event's name, for example `launchFlight` or `flightCompleted`. */
  readonly type: string;
  readonly actor: LogActor;
  readonly missionId: string | null;
  readonly aircraftId: string | null;
  readonly flightId: string | null;
  readonly payload: LogPayload;
}

/** What an entry concerns. Omitted ids are recorded as `null`. */
export interface LogSubject {
  readonly missionId?: string | null;
  readonly aircraftId?: string | null;
  readonly flightId?: string | null;
}

/** How subsystems report what happened during a step. */
export type EmitEvent = (type: string, subject: LogSubject, payload?: LogPayload) => void;

export interface LogSnapshot {
  /** Sequence number the next entry will take. */
  readonly nextSeq: number;
  /**
   * The tick from which the log records everything. 0 for a world that has always had a log; later
   * for a world created before the log existed, which therefore cannot be replayed from its seed.
   */
  readonly completeFromTick: number;
  /** The most recent entries, oldest first: every entry not yet saved, plus a recent tail. */
  readonly entries: readonly LogEntry[];
}

export const EMPTY_LOG: LogSnapshot = { nextSeq: 1, completeFromTick: 0, entries: [] };

export class SimLog {
  private nextSeq: number;
  private readonly completeFromTick: number;
  private entries: LogEntry[];
  /** Highest sequence number known to be on disk. */
  private savedSeq: number;

  constructor(snapshot: LogSnapshot = EMPTY_LOG) {
    if (!Number.isSafeInteger(snapshot.nextSeq) || snapshot.nextSeq < 1) {
      throw new Error(`Saved log sequence is invalid: ${snapshot.nextSeq}`);
    }
    if (!Number.isSafeInteger(snapshot.completeFromTick) || snapshot.completeFromTick < 0) {
      throw new Error('Saved log start is invalid');
    }
    let expected = snapshot.nextSeq - snapshot.entries.length;
    for (const entry of snapshot.entries) {
      if (entry.seq !== expected) {
        throw new Error(`Saved log is not contiguous at entry ${entry.seq}`);
      }
      expected += 1;
    }
    this.nextSeq = snapshot.nextSeq;
    this.completeFromTick = snapshot.completeFromTick;
    this.entries = [...snapshot.entries];
    // A restored log came from disk.
    this.savedSeq = snapshot.nextSeq - 1;
  }

  append(
    tick: number,
    kind: LogKind,
    type: string,
    actor: LogActor,
    subject: LogSubject,
    payload: LogPayload = {},
  ): LogEntry {
    const entry: LogEntry = {
      seq: this.nextSeq,
      tick,
      kind,
      type,
      actor,
      missionId: subject.missionId ?? null,
      aircraftId: subject.aircraftId ?? null,
      flightId: subject.flightId ?? null,
      payload,
    };
    this.nextSeq += 1;
    this.entries.push(entry);
    this.trim();
    return entry;
  }

  /** Records that every entry up to `seq` is on disk, so older ones may leave memory. */
  acknowledgeSaved(seq: number): void {
    this.savedSeq = Math.max(this.savedSeq, Math.min(seq, this.nextSeq - 1));
    this.trim();
  }

  /** Keeps every unsaved entry and at most {@link RECENT_LOG} saved ones. */
  private trim(): void {
    const unsaved = this.nextSeq - 1 - this.savedSeq;
    const keep = Math.max(RECENT_LOG, unsaved);
    if (this.entries.length > keep) {
      this.entries = this.entries.slice(this.entries.length - keep);
    }
  }

  snapshot(): LogSnapshot {
    return {
      nextSeq: this.nextSeq,
      completeFromTick: this.completeFromTick,
      entries: [...this.entries],
    };
  }
}
