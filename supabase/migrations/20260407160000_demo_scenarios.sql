-- Hello Cara demo line — editable scenario playbooks (content only; worker falls back to code defaults if empty).

create table if not exists public.demo_scenarios (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  trigger_keywords text[] not null default '{}',
  beats jsonb not null default '[]',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.demo_scenarios is
  'Hello Cara demo line scenario playbooks — 4-beat scripts loaded by the voice worker when is_active.';

create index if not exists demo_scenarios_active_sort_idx
  on public.demo_scenarios (is_active, sort_order);

insert into public.demo_scenarios (slug, label, trigger_keywords, beats, sort_order)
values
  (
    'electrician',
    'Electrician',
    array['electrician', 'electric', 'fuse', 'tripped', 'wiring', 'spark'],
    '[
      {"label":"Ack + value","guidance":"Acknowledge electrician trade in one warm line — answer calls, take messages, text reminders. No prices or hours.","suggestedLine":"Lovely — for an electrician I''d answer every call, take clear messages, and text appointment reminders — want to try a quick example?"},
      {"label":"Invite role-play","guidance":"Invite them to play the customer. Suggest a tripped fuse or need someone out today.","suggestedLine":"Perfect — pretend you''re ringing about a tripped fuse and need someone out today, and I''ll answer like their assistant."},
      {"label":"In-role reply","guidance":"Stay in assistant role. Take a message, ask what the issue is, ask if it is urgent — no invented prices or callback promises.","suggestedLine":"No bother — I can take a message for the electrician and let them know you need someone out; what''s the issue, is it urgent?"},
      {"label":"Wrap demo beat","guidance":"Step out of role-play. Offer another trade example or ask if they are sorted.","suggestedLine":"That''s what your customers would hear — want to try another trade or are you sorted?"}
    ]'::jsonb,
    10
  ),
  (
    'salon',
    'Salon / beauty',
    array['salon', 'hair', 'beauty', 'blow-dry', 'blow dry', 'nails', 'barber'],
    '[
      {"label":"Ack + value","guidance":"Acknowledge salon — no real booking on this demo line. One line on calls, messages, booking links in production.","suggestedLine":"Yeah — for a salon I''d handle calls, take messages, and text booking links on your real line — fancy a quick role-play?"},
      {"label":"Invite role-play","guidance":"Invite customer role-play — ask for a blow-dry or appointment this Saturday.","suggestedLine":"Go for it — ask me for a blow-dry this Saturday like a customer would, and I''ll respond as the salon assistant."},
      {"label":"In-role reply","guidance":"In role — explain you would check availability or send a booking link on their real line. Speech only, no tools.","suggestedLine":"I''d check availability for Saturday and text you a booking link on the salon''s real line — shall I note your preferred time?"},
      {"label":"Wrap demo beat","guidance":"Step out of role-play. Offer another example or close.","suggestedLine":"That''s the idea on a live salon line — another example or are you happy enough?"}
    ]'::jsonb,
    20
  ),
  (
    'mechanic',
    'Mechanic / garage',
    array['mechanic', 'garage', 'mot', 'nct', 'service', 'car repair', 'tyre'],
    '[
      {"label":"Ack + value","guidance":"Acknowledge garage/mechanic — messages, service enquiries, reminders. No invented MOT prices.","suggestedLine":"Perfect — for a garage I''d take service and MOT calls, capture the car details, and pass messages to the team — want to test it?"},
      {"label":"Invite role-play","guidance":"Invite customer role-play — NCT prep or service booking this week.","suggestedLine":"Lovely — pretend you''re asking if we do NCT prep this week, and I''ll answer like the garage assistant."},
      {"label":"In-role reply","guidance":"In role — take car details and message, offer callback in speech only.","suggestedLine":"I can take your details and pass them to the mechanic for a callback — what car is it and when suits you?"},
      {"label":"Wrap demo beat","guidance":"Step out of role-play. Offer another trade or wrap.","suggestedLine":"That''s how it would sound on your line — try another trade or are you sorted?"}
    ]'::jsonb,
    30
  ),
  (
    'retail',
    'Shop / retail',
    array['shop', 'store', 'retail', 'supervalu', 'supermarket', 'grocery', 'butchers'],
    '[
      {"label":"Ack + value","guidance":"Acknowledge retail — hours, directions, department questions on a real line. No invented hours on demo.","suggestedLine":"Sure — on a real shop line I''d answer hours, directions, and department questions from your actual info — want a quick try?"},
      {"label":"Invite role-play","guidance":"Invite customer role-play — ask if open tomorrow or where something is.","suggestedLine":"Pretend you''re asking if the shop is open tomorrow, and I''ll answer like the store assistant."},
      {"label":"In-role reply","guidance":"Decline inventing hours. Explain on their real line you use their actual hours from setup.","suggestedLine":"On your live line I''d use your real opening hours — this demo line doesn''t have a shop attached, but that''s the flow."},
      {"label":"Wrap demo beat","guidance":"Step out of role-play. Offer another example or wrap.","suggestedLine":"That''s the retail flow — another example or are you happy enough?"}
    ]'::jsonb,
    40
  ),
  (
    'general',
    'General Hello Cara',
    array['hello cara', 'cliste', 'what can you do', 'what do you do', 'how does it work', 'tell me about', 'who are you', 'what is this'],
    '[
      {"label":"Value line","guidance":"One line on Hello Cara — AI phone assistant for Irish businesses, never misses a call.","suggestedLine":"Hello Cara is an AI phone assistant for Irish businesses — I answer calls, take messages, and send links so you never miss trade."},
      {"label":"Pick a try","guidance":"Offer a quick role-play — they pick a business type or you suggest electrician or shop.","suggestedLine":"Want to try a quick example — pick any business type or I can walk you through an electrician or shop call?"},
      {"label":"Mini demo","guidance":"Run a short role-play OR explain messages, links, and after-hours in one sentence.","suggestedLine":"Picture a customer ringing after hours — I''d take their message and text them a booking link when the team is back."},
      {"label":"Wrap demo beat","guidance":"Ask if they want another example or are finished exploring.","suggestedLine":"Happy to show another example — or are you sorted for now?"}
    ]'::jsonb,
    50
  )
on conflict (slug) do nothing;
