-- Short human-readable code for SMS confirmations and phone self-service (cancel/reschedule).
alter table public.appointments
  add column if not exists booking_reference text;

update public.appointments
set booking_reference = upper(substr(replace(id::text, '-', ''), 1, 10))
where booking_reference is null;

alter table public.appointments
  alter column booking_reference set not null;

create unique index if not exists appointments_booking_reference_uidx
  on public.appointments (booking_reference);

comment on column public.appointments.booking_reference is
  'Unique code (e.g. for SMS). Quote this when calling the salon to change or cancel.';
