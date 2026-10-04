import { useEffect, useRef, useState } from 'react';
import type { AsyncState } from './useAsync';

/**
 * Returns the same reference for as long as the value's content is unchanged.
 *
 * The simulation publishes a fresh copy of its state several times a second, so objects that
 * have not changed still arrive as new objects. Anything costly that depends on such an object
 * (a mission forecast, for instance) should depend on its stable form instead.
 */
export function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  const held = useRef({ key, value });
  if (held.current.key !== key) held.current = { key, value };
  return held.current.value;
}

/**
 * The most recent successful result of an asynchronous read. While a newer read is in progress
 * the previous result stays on screen, so a list that is re-read periodically does not flicker.
 */
export function useLastReady<T>(state: AsyncState<T>): T | null {
  const [last, setLast] = useState<T | null>(null);
  useEffect(() => {
    if (state.status === 'ready') setLast(state.value);
  }, [state]);
  return state.status === 'ready' ? state.value : last;
}
