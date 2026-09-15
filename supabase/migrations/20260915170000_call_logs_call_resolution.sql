-- Post-call LLM judgment for owner dashboard badges (replaces summary regex heuristics).
alter table public.call_logs
  add column if not exists call_resolution text
  check (call_resolution in ('resolved', 'incomplete', 'needs_follow_up'));

comment on column public.call_logs.call_resolution is
  'Post-call LLM: resolved | incomplete (pleasantries only / no errand) | needs_follow_up';
