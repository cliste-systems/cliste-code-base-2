import { checkSlotAgainstBusinessHours } from './business_hours.js';
import {
  customerPhonesMatch,
  generateBookingReference,
  normalizeCustomerPhoneE164,
} from './booking_reference.js';
import { getSupabaseClient } from './supabase.js';

export const DEFAULT_SLOT_MINUTES = 60;

export type AppointmentSource = 'booking_link' | 'ai_call' | 'dashboard';

type ServiceRow = {
  id: string;
  name: string;
  duration_minutes: number | null;
};

export type CustomerAppointmentRow = {
  id: string;
  bookingReference: string;
  serviceName: string;
  startIso: string;
  endIso: string;
};

export async function findServiceForOrg(
  organizationId: string,
  name: string,
): Promise<ServiceRow | null> {
  const supabase = getSupabaseClient();
  const n = name.trim();
  if (!n) {
    return null;
  }

  const { data: exact, error: e1 } = await supabase
    .from('services')
    .select('id, name, duration_minutes')
    .eq('organization_id', organizationId)
    .ilike('name', n)
    .maybeSingle();

  if (e1) {
    throw e1;
  }
  if (exact) {
    return exact as ServiceRow;
  }

  const { data: partial, error: e2 } = await supabase
    .from('services')
    .select('id, name, duration_minutes')
    .eq('organization_id', organizationId)
    .ilike('name', `%${n}%`)
    .limit(1)
    .maybeSingle();

  if (e2) {
    throw e2;
  }
  return partial as ServiceRow | null;
}

export function resolveDurationMinutes(svc: ServiceRow | null, fallback: number): number {
  const d = svc?.duration_minutes;
  if (d != null && d > 0) {
    return d;
  }
  return fallback;
}

export async function slotConflicts(
  organizationId: string,
  start: Date,
  end: Date,
  excludeAppointmentId?: string,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  let q = supabase
    .from('appointments')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('status', 'confirmed')
    .lt('start_time', end.toISOString())
    .gt('end_time', start.toISOString());
  if (excludeAppointmentId?.trim()) {
    q = q.neq('id', excludeAppointmentId.trim());
  }
  const { data, error } = await q.limit(1);

  if (error) {
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

export function businessHoursBlockReason(
  start: Date,
  durationMinutes: number,
  businessHours: unknown,
  timeZone: string,
): string | null {
  const r = checkSlotAgainstBusinessHours(start, durationMinutes, businessHours, timeZone);
  if (r.allowed) {
    return null;
  }
  return r.reason;
}

export async function checkSlotAvailable(
  organizationId: string,
  startIso: string,
  durationMinutes: number,
  options?: {
    businessHours?: unknown;
    timeZone?: string;
    /** When rescheduling, ignore this appointment’s row for overlap checks. */
    excludeAppointmentId?: string;
  },
): Promise<{
  available: boolean;
  message: string;
  startIso: string | null;
  endIso: string | null;
}> {
  const start = new Date(startIso.trim());
  if (Number.isNaN(start.getTime())) {
    return {
      available: false,
      message: 'Invalid datetime',
      startIso: null,
      endIso: null,
    };
  }
  const tz = options?.timeZone?.trim() || 'UTC';
  const bh = options?.businessHours;
  const hoursReason = businessHoursBlockReason(start, durationMinutes, bh, tz);
  if (hoursReason) {
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return {
      available: false,
      message: `${hoursReason} Offer a time inside salon opening hours from your instructions.`,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const conflict = await slotConflicts(organizationId, start, end, options?.excludeAppointmentId);
  return {
    available: !conflict,
    message: conflict ? 'That slot overlaps an existing appointment.' : 'Slot appears free.',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export async function insertAppointment(params: {
  organizationId: string;
  customerName: string;
  customerPhone: string;
  serviceId: string;
  start: Date;
  end: Date;
  source: AppointmentSource;
}): Promise<{ bookingReference: string; id: string }> {
  const supabase = getSupabaseClient();
  const phone = normalizeCustomerPhoneE164(params.customerPhone);
  for (let attempt = 0; attempt < 12; attempt++) {
    const bookingReference = generateBookingReference();
    const { data, error } = await supabase
      .from('appointments')
      .insert({
        organization_id: params.organizationId,
        service_id: params.serviceId,
        customer_name: params.customerName,
        customer_phone: phone,
        booking_reference: bookingReference,
        start_time: params.start.toISOString(),
        end_time: params.end.toISOString(),
        status: 'confirmed',
        source: params.source,
      })
      .select('id')
      .single();
    if (!error && data?.id) {
      return { bookingReference, id: data.id as string };
    }
    const msg = error?.message ?? '';
    if (msg.includes('booking_reference') || msg.includes('23505')) {
      continue;
    }
    throw error;
  }
  throw new Error('Could not allocate a unique booking reference');
}

/** Dashboard reads `appointments.confirmation_sms_sent_at` (see code-base-1 bookings UI). */
export async function setAppointmentConfirmationSmsSentAt(appointmentId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const at = new Date().toISOString();
  const { error } = await supabase
    .from('appointments')
    .update({ confirmation_sms_sent_at: at })
    .eq('id', appointmentId.trim());
  if (error) {
    console.error('[appointments] confirmation_sms_sent_at update failed', error);
  }
}

/** Link the call history row to the booking row (dashboard "Call" section). */
export async function linkAppointmentToCallLog(appointmentId: string, callLogId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('appointments')
    .update({ call_log_id: callLogId.trim() })
    .eq('id', appointmentId.trim());
  if (error) {
    console.error('[appointments] call_log_id update failed', error);
  }
}

/** Upcoming confirmed appointments for this phone (normalized match), soonest first. */
export async function listUpcomingAppointmentsForCustomer(params: {
  organizationId: string;
  customerPhone: string;
}): Promise<CustomerAppointmentRow[]> {
  const supabase = getSupabaseClient();
  const want = normalizeCustomerPhoneE164(params.customerPhone);
  const { data, error } = await supabase
    .from('appointments')
    .select(
      'id, booking_reference, start_time, end_time, customer_phone, services ( name )',
    )
    .eq('organization_id', params.organizationId)
    .eq('status', 'confirmed')
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(40);

  if (error) {
    throw error;
  }
  const out: CustomerAppointmentRow[] = [];
  for (const row of data ?? []) {
    const r = row as {
      id: string;
      booking_reference: string;
      start_time: string;
      end_time: string;
      customer_phone: string;
      services: { name: string } | { name: string }[] | null;
    };
    if (!customerPhonesMatch(r.customer_phone, want)) {
      continue;
    }
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    out.push({
      id: r.id,
      bookingReference: r.booking_reference,
      serviceName: typeof svc?.name === 'string' ? svc.name : 'Appointment',
      startIso: r.start_time,
      endIso: r.end_time,
    });
  }
  return out;
}

type LoadedCustomerAppt = {
  id: string;
  bookingReference: string;
  serviceId: string;
  durationMinutes: number;
  serviceName: string;
  customerName: string;
  start: Date;
  end: Date;
};

async function loadConfirmedAppointmentForCustomer(
  organizationId: string,
  bookingReference: string,
  customerPhone: string,
): Promise<LoadedCustomerAppt | null> {
  const ref = bookingReference.trim().toUpperCase();
  if (ref.length < 4) {
    return null;
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('appointments')
    .select(
      'id, booking_reference, customer_name, customer_phone, start_time, end_time, service_id, status, services ( duration_minutes, name )',
    )
    .eq('organization_id', organizationId)
    .eq('booking_reference', ref)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data || (data as { status: string }).status !== 'confirmed') {
    return null;
  }
  const row = data as {
    id: string;
    booking_reference: string;
    customer_name: string;
    customer_phone: string;
    start_time: string;
    end_time: string;
    service_id: string;
    services:
      | { duration_minutes: number | null; name: string }
      | { duration_minutes: number | null; name: string }[]
      | null;
  };
  if (!customerPhonesMatch(row.customer_phone, customerPhone)) {
    return null;
  }
  const svc = Array.isArray(row.services) ? row.services[0] : row.services;
  const durationMinutes =
    svc?.duration_minutes != null && svc.duration_minutes > 0
      ? svc.duration_minutes
      : DEFAULT_SLOT_MINUTES;
  return {
    id: row.id,
    bookingReference: row.booking_reference,
    serviceId: row.service_id,
    durationMinutes,
    serviceName: typeof svc?.name === 'string' ? svc.name : 'Service',
    customerName: row.customer_name.trim() || 'Customer',
    start: new Date(row.start_time),
    end: new Date(row.end_time),
  };
}

export async function cancelAppointmentForCustomer(params: {
  organizationId: string;
  bookingReference: string;
  customerPhone: string;
}): Promise<
  | {
      ok: true;
      bookingReference: string;
      serviceName: string;
      customerName: string;
    }
  | { ok: false; message: string }
> {
  const row = await loadConfirmedAppointmentForCustomer(
    params.organizationId,
    params.bookingReference,
    params.customerPhone,
  );
  if (!row) {
    return {
      ok: false,
      message:
        'No matching booking for that reference on this phone. Ask them to check the text or spell the reference.',
    };
  }
  if (row.start.getTime() <= Date.now()) {
    return {
      ok: false,
      message: 'That appointment is already past or starting now; staff may need to help.',
    };
  }
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', row.id)
    .eq('organization_id', params.organizationId);

  if (error) {
    throw error;
  }
  return {
    ok: true,
    bookingReference: row.bookingReference,
    serviceName: row.serviceName,
    customerName: row.customerName,
  };
}

export async function rescheduleAppointmentForCustomer(params: {
  organizationId: string;
  bookingReference: string;
  customerPhone: string;
  newStartIso: string;
  businessHours: unknown;
  timeZone: string;
}): Promise<
  | {
      ok: true;
      bookingReference: string;
      serviceName: string;
      customerName: string;
      newStart: Date;
    }
  | { ok: false; message: string }
> {
  const row = await loadConfirmedAppointmentForCustomer(
    params.organizationId,
    params.bookingReference,
    params.customerPhone,
  );
  if (!row) {
    return {
      ok: false,
      message:
        'No matching booking for that reference on this phone. Ask them to check the text or spell the reference.',
    };
  }
  const newStart = new Date(params.newStartIso.trim());
  if (Number.isNaN(newStart.getTime())) {
    return { ok: false, message: 'Invalid new date/time.' };
  }
  const result = await checkSlotAvailable(
    params.organizationId,
    newStart.toISOString(),
    row.durationMinutes,
    {
      businessHours: params.businessHours,
      timeZone: params.timeZone,
      excludeAppointmentId: row.id,
    },
  );
  if (!result.available) {
    return { ok: false, message: result.message };
  }
  const newEnd = new Date(newStart.getTime() + row.durationMinutes * 60_000);
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('appointments')
    .update({
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString(),
    })
    .eq('id', row.id)
    .eq('organization_id', params.organizationId);

  if (error) {
    throw error;
  }
  return {
    ok: true,
    bookingReference: row.bookingReference,
    serviceName: row.serviceName,
    customerName: row.customerName,
    newStart,
  };
}
