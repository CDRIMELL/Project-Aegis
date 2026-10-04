import { useEffect, useState } from 'react';

export type AsyncState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly error: string };

/**
 * Runs `load` whenever `key` changes and reports its state. A result that arrives after the key
 * has changed again is discarded, so a slow earlier request can never overwrite a newer one.
 */
export function useAsync<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<{ key: string; result: AsyncState<T> }>({
    key,
    result: { status: 'loading' },
  });

  useEffect(() => {
    let current = true;
    load().then(
      (value) => {
        if (current) setState({ key, result: { status: 'ready', value } });
      },
      (reason: unknown) => {
        if (current) {
          const error = reason instanceof Error ? reason.message : String(reason);
          setState({ key, result: { status: 'failed', error } });
        }
      },
    );
    return () => {
      current = false;
    };
    // `load` is intentionally not a dependency: callers pass a fresh closure each render, and
    // `key` is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.key === key ? state.result : { status: 'loading' };
}
