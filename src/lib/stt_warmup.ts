import { inference } from '@livekit/agents';

const DEFAULT_WARMUP_MODEL = 'assemblyai/u3-rt-pro';

let warmupDone = false;
let warmupInFlight: Promise<void> | null = null;

function sttWarmupEnabled(): boolean {
  const raw = process.env.LIVEKIT_STT_WARMUP?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

async function runSttWarmup(): Promise<void> {
  const model =
    process.env.LIVEKIT_INFERENCE_STT_MODEL?.trim() ||
    process.env.LIVEKIT_STT_WARMUP_MODEL?.trim() ||
    DEFAULT_WARMUP_MODEL;
  const language = process.env.LIVEKIT_INFERENCE_STT_LANGUAGE?.trim() || 'en';
  const timeoutMs = Number.parseInt(process.env.LIVEKIT_STT_WARMUP_TIMEOUT_MS ?? '2500', 10) || 2500;

  const sttInstance = new inference.STT({
    model,
    language,
    modelOptions: { interim_results: true },
  });

  const startedAt = Date.now();
  const stream = sttInstance.stream();
  let closed = false;

  const closeStream = () => {
    if (closed) return;
    closed = true;
    try {
      stream.endInput();
    } catch {
      /* ignore */
    }
    try {
      stream.close();
    } catch {
      /* ignore */
    }
    try {
      void sttInstance.close();
    } catch {
      /* ignore */
    }
  };

  const timer = setTimeout(closeStream, timeoutMs);

  try {
    for await (const _event of stream) {
      if (Date.now() - startedAt > timeoutMs) break;
    }
  } catch (err) {
    console.warn('[agent] stt_warmup_stream_error', {
      model,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
    closeStream();
    console.info('[agent] stt_warmup_complete', {
      model,
      ms: Date.now() - startedAt,
    });
  }
}

/** One short STT connect per worker boot — must finish before calls to avoid quota fights. */
export async function prewarmInferenceStt(): Promise<void> {
  if (!sttWarmupEnabled() || warmupDone) return;
  if (warmupInFlight) {
    await warmupInFlight;
    return;
  }

  warmupInFlight = runSttWarmup()
    .catch((err) => {
      console.warn('[agent] stt_warmup_failed', err);
    })
    .finally(() => {
      warmupDone = true;
      warmupInFlight = null;
    });

  await warmupInFlight;
}
