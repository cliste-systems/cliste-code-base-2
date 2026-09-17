import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRetailHoursSpokenReply } from './retail_hours.js';
import { mergeHoursOverrideIntoBundle } from './business_hours_overrides.js';

const baseHours = {
  monday: { open: true, start: '08:00', end: '21:00' },
  tuesday: { open: true, start: '08:00', end: '21:00' },
  wednesday: { open: true, start: '08:00', end: '21:00' },
  thursday: { open: true, start: '08:00', end: '21:00' },
  friday: { open: true, start: '08:00', end: '21:00' },
  saturday: { open: true, start: '08:00', end: '21:00' },
  sunday: { open: true, start: '09:00', end: '18:00' },
  _hoursNote: 'Mon–Sat: 8am–9pm\nSunday: 9am–6pm',
  _bankHolidaysConfigured: true,
  _bankHolidaysOpen: false,
};

test('mergeHoursOverrideIntoBundle applies temporary close time for today', () => {
  const merged = mergeHoursOverrideIntoBundle(baseHours, {
    id: 'override-1',
    organization_id: 'org-1',
    label: 'Temporary hours today: Thursday: 8am–6pm',
    schedule: {
      ...baseHours,
      thursday: { open: true, start: '08:00', end: '18:00' },
    },
    expires_at: '2026-09-18T00:00:00.000Z',
  });

  const reply = buildRetailHoursSpokenReply(
    merged,
    'are you open today',
    'Europe/Dublin',
    { ref: new Date('2026-09-17T12:00:00.000Z') },
  );

  assert.match(reply ?? '', /six|6/i);
  assert.doesNotMatch(reply ?? '', /\b9\s*pm\b/i);
});
