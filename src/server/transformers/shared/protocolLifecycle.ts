type PulledEventBatch<TEvent> = {
  events: TEvent[];
  rest: string;
};

type ProxyStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ProxyStreamLifecycleInput<TEvent> = {
  reader: ProxyStreamReader | null | undefined;
  response: { end(): void };
  pullEvents(buffer: string): PulledEventBatch<TEvent>;
  handleEvent(event: TEvent): Promise<boolean | void> | boolean | void;
  onEof?: () => Promise<void> | void;
  /**
   * Deadline for a single upstream read. An upstream that opens the stream and then stops
   * sending leaves `reader.read()` pending forever, holding the client connection, the
   * channel lease and a retry slot; 0 disables the deadline.
   */
  idleTimeoutMs?: number;
  /**
   * Called when the first-byte deadline fires, so the stall leaves a trace naming the model
   * instead of looking like an upstream that simply ended the stream.
   */
  onFirstByteTimeout?: (elapsedMs: number) => void;
}

const IDLE_TIMEOUT = Symbol('proxy-stream-idle-timeout');

function readWithIdleTimeout<T>(read: Promise<T>, idleTimeoutMs: number): Promise<T | typeof IDLE_TIMEOUT> {
  if (idleTimeoutMs <= 0) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof IDLE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(IDLE_TIMEOUT), idleTimeoutMs);
    timer.unref?.();
  });
  return Promise.race([read, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

export function createProxyStreamLifecycle<TEvent>(input: ProxyStreamLifecycleInput<TEvent>) {
  const flushBuffer = async (buffer: string): Promise<{ rest: string; stop: boolean }> => {
    const pulled = input.pullEvents(buffer);
    for (const event of pulled.events) {
      if (await input.handleEvent(event)) {
        return {
          rest: pulled.rest,
          stop: true,
        };
      }
    }

    return {
      rest: pulled.rest,
      stop: false,
    };
  };

  return {
    async run(): Promise<void> {
      const reader = input.reader;
      if (!reader) {
        try {
          await input.onEof?.();
        } finally {
          input.response.end();
        }
        return;
      }

      const decoder = new TextDecoder();
      const idleTimeoutMs = Math.max(0, Math.trunc(input.idleTimeoutMs ?? 0));
      let sseBuffer = '';
      let shouldStop = false;

      try {
        // Only the wait for the FIRST byte is bounded. Mid-stream silence is not the same
        // signal: a reasoning model may think for minutes between deltas while the request
        // is healthy, and the configured value is a first-byte budget. Cutting those would
        // truncate good answers; a genuinely dead mid-stream connection is caught by the
        // client-abort signal instead.
        let receivedAny = false;
        while (true) {
          const next = await readWithIdleTimeout(reader.read(), receivedAny ? 0 : idleTimeoutMs);
          if (next === IDLE_TIMEOUT) {
            // Treat it as an upstream stall: stop reading and let onEof synthesise the
            // terminal state from what was actually delivered.
            input.onFirstByteTimeout?.(idleTimeoutMs);
            await reader.cancel().catch(() => {});
            break;
          }
          const { done, value } = next;
          if (done) break;
          if (value) receivedAny = true;
          if (!value) continue;

          sseBuffer += decoder.decode(value, { stream: true });
          const flushed = await flushBuffer(sseBuffer);
          sseBuffer = flushed.rest;
          if (!flushed.stop) continue;

          shouldStop = true;
          await reader.cancel().catch(() => {});
          break;
        }

        if (!shouldStop) {
          sseBuffer += decoder.decode();
          if (sseBuffer.trim().length > 0) {
            const flushed = await flushBuffer(`${sseBuffer}\n\n`);
            sseBuffer = flushed.rest;
            shouldStop = flushed.stop;
          }
        }

        if (!shouldStop) {
          await input.onEof?.();
        }
      } finally {
        reader.releaseLock();
        input.response.end();
      }
    },
  };
}
