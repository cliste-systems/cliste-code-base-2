-- Estimated per-call infrastructure cost (USD) written by the voice worker.
-- Admin UI: sum (cost_estimate->>'totalUsd')::numeric for daily totals.

alter table public.call_logs
  add column if not exists cost_estimate jsonb;

comment on column public.call_logs.cost_estimate is
  'Heuristic USD cost breakdown: totalUsd, breakdown.{livekit,stt,llmVoice,tts,twilioVoice,twilioSms,supabase,postprocessLlm}, models, assumptions';

-- Daily rollup per organization (UTC midnight buckets).
create or replace view public.call_cost_daily_with_estimate as
select
  (created_at at time zone 'utc')::date as day_utc,
  organization_id,
  count(*) filter (where cost_estimate is not null) as calls_with_estimate,
  count(*) as calls_total,
  coalesce(
    sum((cost_estimate->>'totalUsd')::double precision) filter (where cost_estimate ? 'totalUsd'),
    0
  )::numeric(12, 5) as total_estimated_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'livekit')::double precision) filter (where cost_estimate->'breakdown' ? 'livekit'),
    0
  )::numeric(12, 5) as livekit_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'stt')::double precision) filter (where cost_estimate->'breakdown' ? 'stt'),
    0
  )::numeric(12, 5) as stt_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'llmVoice')::double precision) filter (where cost_estimate->'breakdown' ? 'llmVoice'),
    0
  )::numeric(12, 5) as llm_voice_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'tts')::double precision) filter (where cost_estimate->'breakdown' ? 'tts'),
    0
  )::numeric(12, 5) as tts_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'twilioVoice')::double precision) filter (where cost_estimate->'breakdown' ? 'twilioVoice'),
    0
  )::numeric(12, 5) as twilio_voice_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'twilioSms')::double precision) filter (where cost_estimate->'breakdown' ? 'twilioSms'),
    0
  )::numeric(12, 5) as twilio_sms_usd,
  coalesce(
    sum((cost_estimate->'breakdown'->>'postprocessLlm')::double precision) filter (where cost_estimate->'breakdown' ? 'postprocessLlm'),
    0
  )::numeric(12, 5) as postprocess_llm_usd
from public.call_logs
group by 1, 2;

comment on view public.call_cost_daily_with_estimate is
  'Aggregates call_logs.cost_estimate by UTC day for admin dashboards.';
