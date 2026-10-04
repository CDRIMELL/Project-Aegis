import { formatUtc, isSpeedMultiplier, SPEED_MULTIPLIERS } from '@aegis/domain';
import { Button, SegmentedControl, StatusBadge, TimeReadout } from '@aegis/ui';
import { Pause, Play } from 'lucide-react';
import { simClient } from '../../sim/client';
import { useSimStore } from '../../state/sim-store';

const SPEED_OPTIONS = SPEED_MULTIPLIERS.map((speed) => ({
  value: String(speed),
  label: `${speed}×`,
}));

/** Global simulation clock and time controls, shown on every screen. */
export function SimClockBar() {
  const clock = useSimStore((state) => state.view?.clock ?? null);
  const phase = useSimStore((state) => state.phase);
  const controllable = phase === 'ready' && clock !== null;

  // `2026-10-04T12:00:05Z` -> date and time parts.
  const [date, time] = clock ? formatUtc(clock.simTime).replace('Z', '').split('T') : [null, null];

  return (
    <div className="flex items-center gap-4">
      {phase === 'failed' ? (
        <StatusBadge tone="critical">Stopped</StatusBadge>
      ) : clock === null ? (
        <StatusBadge tone="neutral">Starting</StatusBadge>
      ) : clock.running ? (
        <StatusBadge tone="ok">Running</StatusBadge>
      ) : (
        <StatusBadge tone="neutral">Paused</StatusBadge>
      )}

      <TimeReadout
        label="Sim time"
        date={date ?? null}
        time={time ?? null}
        zone="UTC"
        hint="Simulated time. It advances only while the simulation runs."
      />

      <SegmentedControl
        label="Simulation speed"
        value={String(clock?.speed ?? 1)}
        options={SPEED_OPTIONS}
        disabled={!controllable}
        onChange={(value) => {
          const speed = Number(value);
          if (isSpeedMultiplier(speed)) {
            simClient.send({ type: 'setSpeed', speed });
          }
        }}
      />

      <Button
        size="sm"
        className="w-24"
        variant={clock?.running ? 'secondary' : 'primary'}
        icon={clock?.running ? Pause : Play}
        disabled={!controllable}
        onClick={() => {
          simClient.send({ type: clock?.running ? 'pause' : 'resume' });
        }}
      >
        {clock?.running ? 'Pause' : 'Resume'}
      </Button>
    </div>
  );
}
