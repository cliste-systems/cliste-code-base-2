import * as openai from '@livekit/agents-plugin-openai';
import WebSocket from 'ws';

/** OpenAI GPT-Live Irish English feminine voice (9508 retail default). */
export const GPT_LIVE_RETAIL_VOICE_DEFAULT = 'willow';

/** Backend Responses model for tool/reasoning delegation. */
export const GPT_LIVE_RETAIL_BACKEND_DEFAULT = 'gpt-5.6-luna';

const GPT_LIVE_PROBE_TTL_MS = 5 * 60_000;
const GPT_LIVE_PROBE_TIMEOUT_MS = 8_000;

type GptLiveProbeCache = {
  ok: boolean;
  reason: string | null;
  checkedAt: number;
};

let gptLiveProbeCache: GptLiveProbeCache | null = null;

export function resolveGptLiveRetailVoice(): string {
  return process.env.CARA_GPT_LIVE_VOICE?.trim() || GPT_LIVE_RETAIL_VOICE_DEFAULT;
}

export function resolveGptLiveRetailBackendModel(): string {
  return process.env.CARA_GPT_LIVE_BACKEND_MODEL?.trim() || GPT_LIVE_RETAIL_BACKEND_DEFAULT;
}

/** Kavanaghs 9508 — full-duplex GPT-Live-1 with Irish voice (Option A). */
export function shouldUseGptLiveRetailStack(input: { conversationalRetailLine: boolean }): boolean {
  if (!input.conversationalRetailLine) return false;
  const raw = process.env.CARA_GPT_LIVE_RETAIL?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

export type GptLiveAvailability = {
  ok: boolean;
  reason: string | null;
};

function resolveOpenAiLiveSessionsUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/live/sessions')) url.pathname += '/live/sessions';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function summarizeGptLiveError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown_error';
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : null;
  const type = typeof record.type === 'string' ? record.type : null;
  const message = typeof record.message === 'string' ? record.message : null;
  return [code, type, message].filter(Boolean).join(':') || 'unknown_error';
}

/** Quick OpenAI Live session.start probe — cached to avoid adding latency to every call. */
export async function probeGptLiveAvailability(): Promise<GptLiveAvailability> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: 'missing_openai_api_key' };
  }

  if (process.env.CARA_GPT_LIVE_SKIP_PROBE?.trim() === '1') {
    return { ok: true, reason: null };
  }

  if (gptLiveProbeCache && Date.now() - gptLiveProbeCache.checkedAt < GPT_LIVE_PROBE_TTL_MS) {
    return { ok: gptLiveProbeCache.ok, reason: gptLiveProbeCache.reason };
  }

  const voice = resolveGptLiveRetailVoice();
  const backendModel = resolveGptLiveRetailBackendModel();

  const result = await new Promise<GptLiveAvailability>((resolve) => {
    let settled = false;
    const finish = (value: GptLiveAvailability) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const ws = new WebSocket(resolveOpenAiLiveSessionsUrl(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'cliste-gpt-live-probe',
      },
    });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'probe_timeout' });
    }, GPT_LIVE_PROBE_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.start',
          event_id: 'cliste_gpt_live_probe',
          session: {
            model: 'gpt-live-1',
            instructions: 'Speak Irish English.',
            audio: {
              format: { type: 'audio/pcm', rate: 24000 },
              output: { voice },
            },
            delegation: {
              type: 'responses',
              responses: {
                model: backendModel,
                instructions: 'Use tools when needed.',
              },
            },
          },
        }),
      );
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const event = JSON.parse(data.toString()) as { type?: string; error?: unknown };
        if (event.type === 'session.started') {
          finish({ ok: true, reason: null });
        } else if (event.type === 'error') {
          finish({ ok: false, reason: summarizeGptLiveError(event.error) });
        }
      } catch {
        finish({ ok: false, reason: 'probe_parse_error' });
      }
    });

    ws.on('error', () => {
      finish({ ok: false, reason: 'probe_websocket_error' });
    });

    ws.on('close', () => {
      finish({ ok: false, reason: 'probe_closed_before_start' });
    });
  });

  gptLiveProbeCache = {
    ok: result.ok,
    reason: result.reason,
    checkedAt: Date.now(),
  };

  if (!result.ok) {
    console.warn('[gpt_live] availability_probe_failed', result);
  } else {
    console.info('[gpt_live] availability_probe_ok');
  }

  return result;
}

export type ResolvedGptLiveRetailModel = {
  instance: openai.realtime.GPTLiveModel;
  label: string;
  voice: string;
  backendModel: string;
};

export async function resolveGptLiveRetailModel(): Promise<ResolvedGptLiveRetailModel | null> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[gpt_live] OPENAI_API_KEY missing — falling back to inference retail stack');
    return null;
  }

  const availability = await probeGptLiveAvailability();
  if (!availability.ok) {
    console.warn('[gpt_live] unavailable — falling back to inference retail stack', availability);
    return null;
  }

  const voice = resolveGptLiveRetailVoice();
  const backendModel = resolveGptLiveRetailBackendModel();

  return {
    voice,
    backendModel,
    label: `openai/gpt-live-1:${voice}+${backendModel}`,
    instance: new openai.realtime.GPTLiveModel({
      voice,
      responsesOptions: {
        model: backendModel,
        instructions:
          'Speak Irish English. Use retail lookup tools when the caller asks about products, stock, hours, or departments. Keep spoken replies concise for phone.',
      },
    }),
  };
}

/** @deprecated Prefer resolveGptLiveRetailModel() which probes availability first. */
export function createGptLiveRetailModel(): ResolvedGptLiveRetailModel | null {
  if (!process.env.OPENAI_API_KEY?.trim()) return null;
  const voice = resolveGptLiveRetailVoice();
  const backendModel = resolveGptLiveRetailBackendModel();
  return {
    voice,
    backendModel,
    label: `openai/gpt-live-1:${voice}+${backendModel}`,
    instance: new openai.realtime.GPTLiveModel({
      voice,
      responsesOptions: {
        model: backendModel,
        instructions:
          'Speak Irish English. Use retail lookup tools when the caller asks about products, stock, hours, or departments. Keep spoken replies concise for phone.',
      },
    }),
  };
}

export function buildGptLiveRetailOpeningInstructions(greetingText: string): string {
  const trimmed = greetingText.trim();
  return (
    'You are answering an inbound phone call. Speak Irish English. ' +
    'Say this opening exactly, naturally and warmly, then stop and listen for the caller:\n' +
    `"${trimmed}"`
  );
}
