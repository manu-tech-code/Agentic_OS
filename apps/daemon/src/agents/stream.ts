/** A one-way async stream: pieces pushed in from callbacks come out of a for-await loop. */
export function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown;
  return {
    push(item: T) {
      if (finished) return;
      items.push(item);
      wake?.();
    },
    end(error?: unknown) {
      if (finished) return;
      finished = true;
      failure = error;
      wake?.();
    },
    get ended() {
      return finished;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

export type Channel<T> = ReturnType<typeof channel<T>>;
