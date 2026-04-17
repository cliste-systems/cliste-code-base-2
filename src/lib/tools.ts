import { audioFramesFromFile, llm, voice } from '@livekit/agents';
import { RoomServiceClient } from 'livekit-server-sdk';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { z } from 'zod';

import { insertActionTicket } from './action_tickets.js';
import {
  DEFAULT_SLOT_MINUTES,
  businessHoursBlockReason,
  cancelAppointmentForCustomer,
  checkSlotAvailable,
  findServiceForOrg,
  insertAppointment,
  linkAppointmentToCallLog,
  setAppointmentConfirmationSmsSentAt,
  listUpcomingAppointmentsForCustomer,
  rescheduleAppointmentForCustomer,
  resolveDurationMinutes,
  slotConflicts,
} from './booking.js';
import {
  bookingPaymentSmsBody,
  createBookingCheckoutSession,
  paymentLinkOnlySmsBody,
} from './payments.js';
import { matchServicesFromUtterance } from './service_menu_match.js';
import { stripeIsConfigured } from './stripe.js';
import { getSalonServices, getSupabaseClient } from './supabase.js';
import { formatSlotTimeSpoken } from './time_speech.js';

/** Mutated during the call; read on session close for call_logs.outcome. */
export type SessionCallFlags = {
  appointmentBooked: boolean;
  linkSent: boolean;
  actionTicketCreated: boolean;
  /** Twilio SMS segments successfully sent (booking link + confirmations). */
  smsSent: number;
  /** Set after endPhoneCall tool runs so we cannot hang up twice. */
  endPhoneCallUsed: boolean;
  /** Stripe Checkout URLs sent this call (for call summary / audits). */
  paymentLinksSent: number;
};

export type SalonAgentUserData = {
  organizationId: string;
  salonName: string;
  bookingLinkUrl: string | null;
  /** Caller line (E.164 best-effort); used for Action Inbox tickets. */
  callerPhone: string;
  sessionFlags: SessionCallFlags;
  /** Native tier: book on this call only; sendBookingLink tool is not registered. */
  nativePlan?: boolean;
  /** `organizations.business_hours` JSON from dashboard; used with bookingTimeZone. */
  businessHours: unknown;
  /** IANA zone for interpreting hours and speaking times (e.g. Europe/Dublin). */
  bookingTimeZone: string;
  /** LiveKit room + caller identity — set by the worker for hang-up. */
  endCallTarget?: { roomName: string; callerIdentity: string };
  /** Latest AI booking this session — linked to `call_logs` on hang-up for the dashboard. */
  lastBookedAppointmentId: string | null;
};

function readSalonUserData(ctx: { userData: unknown }): SalonAgentUserData {
  const ud = ctx.userData as SalonAgentUserData;
  if (!ud?.organizationId) {
    throw new Error('Missing session userData.organizationId');
  }
  return ud;
}

function livekitServiceHttpsHost(): string | null {
  const u = process.env.LIVEKIT_URL?.trim();
  if (!u) {
    return null;
  }
  return u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/** Default bundled phone-hangup SFX (Freesound community clip, relative to this module). */
function defaultPhoneHangupPath(): string {
  return fileURLToPath(new URL('../assets/phone-hangup.mp3', import.meta.url));
}

/** Wait for `session.say` playout without using SpeechHandle.waitForPlayout (forbidden inside tools). */
function waitForSpeechHandlePlayout(handle: {
  done(): boolean;
  addDoneCallback: (cb: (sh: unknown) => void) => void;
}): Promise<void> {
  if (handle.done()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Hang-up sound playout timed out')), 25_000);
    handle.addDoneCallback(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Detects when the model spoke tool names or “end phone call” as dialogue instead of invoking the tool.
 * Used to run a real hang-up so the line still drops.
 */
export function assistantTextSoundsLikeFakeHangup(text: string): boolean {
  const t = text.replace(/\*+/g, ' ').replace(/`+/g, ' ').toLowerCase();
  return /\b(end\s+phone\s+call|endphonecall)\b/.test(t);
}

/**
 * Plays hang-up tone (if available) and removes the SIP participant. Shared by the endPhoneCall tool
 * and the agent output guard when the model says “end phone call” in speech.
 */
export async function disconnectSalonCallerLeg(
  session: voice.AgentSession<SalonAgentUserData>,
  ud: SalonAgentUserData,
  beforeAudio: () => Promise<void>,
): Promise<{ ok: boolean; message: string }> {
  if (ud.sessionFlags.endPhoneCallUsed) {
    return { ok: false, message: 'Hang-up already requested; do not speak again.' };
  }
  const target = ud.endCallTarget;
  if (!target?.roomName?.trim() || !target.callerIdentity?.trim()) {
    return {
      ok: false,
      message:
        'Cannot hang up from this session. Tell them goodbye and they can hang up when ready.',
    };
  }
  const host = livekitServiceHttpsHost();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!host || !key || !secret) {
    console.error('[disconnectSalonCallerLeg] missing LIVEKIT_URL or API credentials');
    return {
      ok: false,
      message:
        'Server could not end the line automatically. Say goodbye warmly and ask them to hang up.',
    };
  }
  ud.sessionFlags.endPhoneCallUsed = true;

  try {
    await beforeAudio();

    const envPath = process.env.PHONE_HANGUP_SOUND_PATH?.trim();
    const resolvedPath =
      envPath && existsSync(envPath) ? envPath : defaultPhoneHangupPath();

    let playedSound = false;
    if (existsSync(resolvedPath)) {
      try {
        const audio = audioFramesFromFile(resolvedPath, {
          sampleRate: 48000,
          numChannels: 1,
          format: 'mp3',
        });
        const handle = session.say(' ', {
          audio,
          addToChatCtx: false,
          allowInterruptions: false,
        });
        await waitForSpeechHandlePlayout(handle);
        playedSound = true;
      } catch (e) {
        console.error('[disconnectSalonCallerLeg] hang-up sound', e);
      }
    } else {
      console.warn('[disconnectSalonCallerLeg] no hang-up sound file at', resolvedPath);
    }

    const postSoundMs = Number.parseInt(process.env.LIVEKIT_END_CALL_POST_SOUND_MS ?? '200', 10);
    const fallbackPadMs = Number.parseInt(process.env.LIVEKIT_END_CALL_DELAY_MS ?? '1200', 10);
    const extraMs = playedSound
      ? Number.isFinite(postSoundMs)
        ? Math.min(Math.max(postSoundMs, 0), 5000)
        : 200
      : Number.isFinite(fallbackPadMs)
        ? Math.min(Math.max(fallbackPadMs, 300), 15000)
        : 1200;
    await new Promise((r) => setTimeout(r, extraMs));

    const client = new RoomServiceClient(host, key, secret);
    await client.removeParticipant(target.roomName.trim(), target.callerIdentity.trim());
    console.log('[disconnectSalonCallerLeg] removeParticipant', {
      room: target.roomName.trim(),
      identity: target.callerIdentity.trim(),
      playedHangupSound: playedSound,
    });
    return {
      ok: true,
      message:
        'Call is ending. Do not generate more speech unless the caller speaks again before disconnect.',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[disconnectSalonCallerLeg]', msg);
    ud.sessionFlags.endPhoneCallUsed = false;
    return {
      ok: false,
      message: `Hang-up failed (${msg}). Say goodbye and ask them to hang up.`,
    };
  }
}

/** Prefer E.164; normalizes Irish national (08…) to +353… for storage and SMS. */
function normalizePhoneE164(phone: string): string {
  const t = phone.trim();
  if (t.startsWith('+')) {
    return t;
  }
  const digits = t.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    return `+353${digits.slice(1)}`;
  }
  if (digits.startsWith('353') && digits.length >= 11) {
    return `+${digits}`;
  }
  return t;
}

async function sendBookingSms(to: string, body: string): Promise<{ ok: boolean; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from =
    process.env.TWILIO_SMS_FROM?.trim() || process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!sid || !token || !from) {
    return { ok: false, detail: 'Twilio env vars not set; tell the customer the link verbally.' };
  }
  const client = twilio(sid, token);
  await client.messages.create({ from, to, body });
  return { ok: true, detail: 'SMS sent.' };
}

function bookingConfirmationSmsBody(input: {
  customerName: string;
  salonName: string;
  serviceName: string;
  start: Date;
  bookingReference: string;
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] || 'there';
  const tz = process.env.SALON_TIMEZONE?.trim() || 'Europe/Dublin';
  let when: string;
  try {
    when = input.start.toLocaleString('en-IE', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    when = input.start.toLocaleString('en-IE', { hour12: true });
  }
  const ref = input.bookingReference.trim();
  return `Hi ${first}, your booking at ${input.salonName} is confirmed: ${input.serviceName} on ${when}. Ref: ${ref}. To change or cancel, call this number and quote your reference. — ${input.salonName}`;
}

function bookingCancelledSmsBody(input: {
  customerName: string;
  salonName: string;
  serviceName: string;
  bookingReference: string;
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] || 'there';
  return `Hi ${first}, your ${input.salonName} booking is cancelled (${input.serviceName}, ref ${input.bookingReference}). — ${input.salonName}`;
}

function bookingRescheduledSmsBody(input: {
  customerName: string;
  salonName: string;
  serviceName: string;
  bookingReference: string;
  newStart: Date;
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] || 'there';
  const tz = process.env.SALON_TIMEZONE?.trim() || 'Europe/Dublin';
  let when: string;
  try {
    when = input.newStart.toLocaleString('en-IE', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    when = input.newStart.toLocaleString('en-IE', { hour12: true });
  }
  return `Hi ${first}, your ${input.salonName} booking (${input.serviceName}, ref ${input.bookingReference}) is now ${when}. See you then! — ${input.salonName}`;
}

export class SalonTools {
  readonly sendBookingLink = llm.tool({
    description:
      'Send the customer an SMS with the online booking link (Fresha or salon URL). Use when they prefer text.',
    parameters: z.object({
      customerPhoneNumber: z
        .string()
        .describe('Customer phone; Irish national ok, e.g. 0871234567 or +353871234567'),
    }),
    execute: async ({ customerPhoneNumber }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const url = ud.bookingLinkUrl?.trim();
      if (!url) {
        console.log('sendBookingLink: no booking URL configured for salon', ud.organizationId);
        return {
          sent: false,
          message: 'No booking link is configured. Offer to book by phone or read services aloud.',
        };
      }
      const body = `Book ${ud.salonName}: ${url}`;
      const sms = await sendBookingSms(normalizePhoneE164(customerPhoneNumber), body);
      console.log('sendBookingLink', { customerPhoneNumber, sms });
      if (sms.ok) {
        ud.sessionFlags.linkSent = true;
        ud.sessionFlags.smsSent += 1;
      }
      return {
        sent: sms.ok,
        message: sms.ok ? 'SMS with booking link was sent.' : sms.detail,
      };
    },
  });

  readonly matchServiceFromUtterance = llm.tool({
    description:
      'Find salon services that match what the caller said when speech-to-text may be wrong (gibberish, homophones) or the phrase is vague. Uses fuzzy search over the live menu and, if configured (OPENAI_API_KEY), a small intent model—no manual keyword lists. Call with what they said before you guess or refuse. After a good match, confirm using **only the real menu name** (e.g. “So that’s a fade?”)—**never** repeat silly STT words aloud (e.g. do not say “you said feed”). Then use that exact menu name in checkAvailability and bookAppointment.',
    parameters: z.object({
      callerPhrase: z
        .string()
        .describe(
          'Rough phrase from the caller (even if the transcript looks like nonsense)',
        ),
    }),
    execute: async ({ callerPhrase }, { ctx }) => {
      try {
        const ud = readSalonUserData(ctx);
        const services = await getSalonServices(ud.organizationId);
        const { suggestions, usedLlm, hint } = await matchServicesFromUtterance(
          callerPhrase,
          services,
        );
        return {
          suggestions: suggestions.map((s) => ({
            serviceName: s.name,
            confidence: Math.round(s.confidence * 100) / 100,
            source: s.source,
            reason: s.reason,
          })),
          usedIntentModel: usedLlm,
          hint,
          servicesOnMenu: services.length,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[matchServiceFromUtterance]', msg);
        return {
          suggestions: [] as { serviceName: string; confidence: number; source: string; reason?: string }[],
          usedIntentModel: false,
          hint: 'Match failed; ask the caller to name the service again or pick from the menu.',
          servicesOnMenu: 0,
          error: `Could not match services (${msg}). Ask what treatment they want.`,
        };
      }
    },
  });

  readonly checkAvailability = llm.tool({
    description:
      '**You must invoke this tool** to verify a slot—never tell the caller you are "checking" or "looking" without calling it in the same turn. Check if an appointment slot is free before booking; always call this before bookAppointment. Pass ISO-8601 datetimes (include timezone, e.g. Z). Only use for services on the salon menu—do not invent services. If the salon has opening hours in your instructions, the slot must fall fully inside those hours or the tool returns unavailable. When the tool returns **spokenTimeLocal**, use that exact phrase for the time—do not paraphrase ISO timestamps (avoids saying "midnight" for noon).',
    parameters: z.object({
      dateTime: z.string().describe('Requested start in ISO-8601'),
      serviceName: z
        .string()
        .optional()
        .describe(
          'Optional: must be a service name from the salon menu (for slot length). Omit if unclear; never pass a service the salon does not list.',
        ),
    }),
    execute: async ({ dateTime, serviceName }, { ctx }) => {
      try {
        const ud = readSalonUserData(ctx);
        let duration = DEFAULT_SLOT_MINUTES;
        if (serviceName?.trim()) {
          const svc = await findServiceForOrg(ud.organizationId, serviceName);
          duration = resolveDurationMinutes(svc, DEFAULT_SLOT_MINUTES);
        }
        const result = await checkSlotAvailable(ud.organizationId, dateTime, duration, {
          businessHours: ud.businessHours,
          timeZone: ud.bookingTimeZone,
        });
        const startIso = result.startIso || undefined;
        return {
          available: result.available,
          startTime: startIso,
          endTime: result.endIso || undefined,
          message: result.message,
          assumedDurationMinutes: duration,
          ...(result.available && startIso
            ? {
                spokenTimeLocal: formatSlotTimeSpoken(startIso, ud.bookingTimeZone),
              }
            : {}),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[checkAvailability]', msg);
        return {
          available: false,
          message: `Slot check failed (${msg}). Apologise briefly and try again or offer createActionTicket.`,
        };
      }
    },
  });

  readonly bookAppointment = llm.tool({
    description:
      'Create a confirmed appointment in the salon calendar (Supabase). Only for a service that exists on the salon menu. Only after slot is free: customer must have **spelled their name** letter-by-letter (at least first name) and you read it back; do not use only audio/STT for spelling. Use ISO-8601 start time matching checkAvailability. After success, a confirmation SMS is sent when Twilio is configured. If the caller has said they want to **pay online**, pass **paymentPreference: "online"** — a secure Stripe Checkout link will be added to the confirmation SMS automatically; otherwise use **"in_person"** (default) and do not ask for card details on the call.',
    parameters: z.object({
      name: z
        .string()
        .describe(
          'Customer name spelling agreed after they spelled it out (first name minimum; add surname if collected)—same spelling for calendar and SMS',
        ),
      phone: z
        .string()
        .describe(
          'Mobile for confirmation SMS—use the number they are calling from unless they explicitly ask for a different phone; Irish national or E.164',
        ),
      service: z
        .string()
        .describe(
          'Service name exactly as on the salon menu (must match a listed service; booking fails if not on the menu)',
        ),
      datetime: z.string().describe('Start time ISO-8601'),
      paymentPreference: z
        .enum(['in_person', 'online'])
        .optional()
        .describe(
          'How the caller wants to pay. "online" = include a secure Stripe payment link in the confirmation SMS (we take card details safely on Stripe — never read them on the phone). "in_person" (default) = they pay at the salon on the day; no link sent. If they did not say, default to in_person and do not ask a second time.',
        ),
    }),
    execute: async ({ name, phone, service, datetime, paymentPreference }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const svc = await findServiceForOrg(ud.organizationId, service);
      if (!svc) {
        return {
          ok: false,
          message: `Could not match service "${service}" to the menu. Ask which service they want.`,
        };
      }
      const duration = resolveDurationMinutes(svc, DEFAULT_SLOT_MINUTES);
      const start = new Date(datetime.trim());
      if (Number.isNaN(start.getTime())) {
        return { ok: false, message: 'Invalid datetime; use ISO-8601.' };
      }
      const end = new Date(start.getTime() + duration * 60_000);

      const hoursReason = businessHoursBlockReason(
        start,
        duration,
        ud.businessHours,
        ud.bookingTimeZone,
      );
      if (hoursReason) {
        return {
          ok: false,
          message: `${hoursReason} Apologise, then run checkAvailability for a time inside opening hours.`,
        };
      }

      const conflict = await slotConflicts(ud.organizationId, start, end);
      if (conflict) {
        return {
          ok: false,
          message: 'That slot is no longer available. Apologize and run checkAvailability again.',
        };
      }

      const raw = phone.trim();
      const line = ud.callerPhone.trim();
      const customerPhone = normalizePhoneE164(
        raw && raw !== 'unknown' ? raw : line,
      );
      if (!customerPhone || customerPhone === 'unknown') {
        return {
          ok: false,
          message:
            'Could not determine a mobile for the text. Ask them to confirm the number for SMS (use the line they are calling from if that is their mobile).',
        };
      }

      const { bookingReference, id: appointmentId } = await insertAppointment({
        organizationId: ud.organizationId,
        customerName: name,
        customerPhone,
        serviceId: svc.id,
        start,
        end,
        source: 'ai_call',
      });
      ud.sessionFlags.appointmentBooked = true;
      ud.lastBookedAppointmentId = appointmentId;

      const serviceNameForSms = typeof svc.name === 'string' ? svc.name : service;
      const wantsOnlinePayment = paymentPreference === 'online';

      // Pay-online branch: create a Stripe Checkout Session and fold the link
      // into the confirmation SMS so the customer gets ONE text with both
      // the booking details and a secure pay link. Webhook in code-base-1
      // flips `payment_status` to `paid` when they complete.
      let paymentNote = '';
      let effectivePaymentPref: 'in_person' | 'online' = 'in_person';

      let smsBody = bookingConfirmationSmsBody({
        customerName: name,
        salonName: ud.salonName,
        serviceName: serviceNameForSms,
        start,
        bookingReference,
      });

      if (wantsOnlinePayment) {
        if (!stripeIsConfigured()) {
          paymentNote =
            'Online payment is not configured on this deployment yet, so I could not send a pay link — they can settle in person on the day.';
        } else {
          const pay = await createBookingCheckoutSession(appointmentId);
          if (pay.ok) {
            smsBody = bookingPaymentSmsBody({
              customerName: name,
              salonName: ud.salonName,
              serviceName: serviceNameForSms,
              start,
              bookingReference,
              amountCents: pay.amountCents,
              currency: pay.currency,
              paymentUrl: pay.url,
              timeZone: ud.bookingTimeZone,
            });
            effectivePaymentPref = 'online';
            ud.sessionFlags.paymentLinksSent += 1;
            paymentNote = `Pay-online link included in the same text (Stripe secure link, ${pay.currency.toUpperCase()} ${(pay.amountCents / 100).toFixed(2)}). They pay on their phone; do not take card details on the call.`;
          } else {
            // Graceful fall-back: keep the plain confirmation SMS, explain to
            // the caller why the link could not be sent.
            paymentNote =
              pay.reason === 'not_onboarded'
                ? 'The salon has not finished their Stripe setup yet, so I could not send a pay link — they can pay in person.'
                : pay.reason === 'no_price'
                  ? 'This service has no set price, so I could not send a pay link — they can pay at the salon.'
                  : `Pay link could not be created (${pay.message}). They can pay in person on the day.`;
          }
        }
      }

      let smsDetail = 'not attempted';
      let smsOk = false;
      try {
        const sms = await sendBookingSms(customerPhone, smsBody);
        smsDetail = sms.detail;
        smsOk = sms.ok;
        console.log('bookAppointment confirmation SMS', {
          customerPhone,
          ok: sms.ok,
          detail: sms.detail,
          paymentPreference: effectivePaymentPref,
        });
        if (sms.ok) {
          ud.sessionFlags.smsSent += 1;
          await setAppointmentConfirmationSmsSentAt(appointmentId);
        } else {
          console.warn('[bookAppointment] SMS failed', sms.detail);
        }
      } catch (e) {
        smsDetail = e instanceof Error ? e.message : String(e);
        console.error('[bookAppointment] SMS error', e);
      }
      const spokenTimeLocal = formatSlotTimeSpoken(start.toISOString(), ud.bookingTimeZone);

      const baseMessage = smsOk
        ? `Booking saved (ref ${bookingReference}). Confirmation text sent to ${customerPhone}.`
        : `Booking saved (ref ${bookingReference}). SMS did not go through (${smsDetail}).`;

      const hangupGuidance = smsOk
        ? 'Say the time using **spokenTimeLocal** (not raw ISO). Repeat the reference aloud. When they need nothing else, invoke endPhoneCall in the same turn as goodbye—do not say "end phone call" as speech.'
        : 'Say the time using **spokenTimeLocal**. Read the reference aloud. For hang-up, invoke endPhoneCall—do not say it as words.';

      const onlineNote =
        effectivePaymentPref === 'online'
          ? 'Tell them the confirmation **with the secure payment link** is on its way to their phone; they pay by tapping the link — never ask for card numbers on the call.'
          : paymentNote
            ? `Payment: ${paymentNote}`
            : '';

      return {
        ok: true,
        spokenTimeLocal,
        paymentPreference: effectivePaymentPref,
        message: [baseMessage, onlineNote, hangupGuidance]
          .filter(Boolean)
          .join(' '),
      };
    },
  });

  /**
   * Follow-up tool for when the caller changes their mind after `bookAppointment`
   * ran with `in_person` (or when the booking was created on another channel).
   * Looks the appointment up by reference AND matches the caller's phone line
   * so we cannot send a stranger a link for someone else's booking.
   *
   * Security posture (matches the web app refund flow):
   * - Booking must belong to the organisation in the session userData.
   * - Caller's phone must match the appointment's stored phone.
   * - Card data never touches us or the LLM — Stripe hosts the form.
   */
  readonly sendPaymentLink = llm.tool({
    description:
      'Send the caller a secure Stripe payment link (SMS) for an existing booking — e.g. when they changed their mind after bookAppointment ran in in_person mode, or they are following up about a booking from another channel. **Never** ask the caller to read their card number — this link sends them to Stripe\'s secure page. Requires the booking reference they have from the confirmation text; only works when the caller is on the same phone number that is on the booking.',
    parameters: z.object({
      bookingReference: z
        .string()
        .describe('Reference from the confirmation text, e.g. AB12CD34'),
    }),
    execute: async ({ bookingReference }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      if (!stripeIsConfigured()) {
        return {
          ok: false,
          message:
            'Online payment is not available on this line yet. They can pay in person on the day.',
        };
      }
      const callerPhone = ud.callerPhone.trim();
      if (!callerPhone || callerPhone === 'unknown') {
        return {
          ok: false,
          message:
            'I cannot verify their line, so I will not text a payment link. Ask them to call from the number on the booking.',
        };
      }

      const ref = bookingReference.trim().toUpperCase();
      if (ref.length < 4) {
        return {
          ok: false,
          message:
            'That booking reference does not look right. Ask them to read it slowly from their confirmation text.',
        };
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('appointments')
        .select('id, customer_phone, customer_name, payment_status, services ( name )')
        .eq('organization_id', ud.organizationId)
        .eq('booking_reference', ref)
        .maybeSingle();
      if (error) {
        console.error('[sendPaymentLink] lookup failed', error);
        return {
          ok: false,
          message:
            'Something went wrong pulling up that booking. Apologise briefly and offer to try again in a moment.',
        };
      }
      if (!data) {
        return {
          ok: false,
          message:
            'No booking matches that reference at this salon. Ask them to check their confirmation text and read the reference again.',
        };
      }
      const row = data as {
        id: string;
        customer_phone: string;
        customer_name: string;
        payment_status: string | null;
        services: { name: string } | { name: string }[] | null;
      };
      const normalizedCaller = normalizePhoneE164(callerPhone);
      const normalizedOnFile = normalizePhoneE164(row.customer_phone);
      if (normalizedCaller !== normalizedOnFile) {
        return {
          ok: false,
          message:
            'That booking is on a different phone number. Ask them to call from the number they used when booking, or log an action ticket.',
        };
      }
      if (row.payment_status === 'paid') {
        return {
          ok: false,
          message:
            'That booking is already paid — let them know the payment went through.',
        };
      }

      const pay = await createBookingCheckoutSession(row.id);
      if (!pay.ok) {
        return { ok: false, message: pay.message };
      }

      const serviceName = Array.isArray(row.services)
        ? row.services[0]?.name ?? pay.serviceName
        : row.services?.name ?? pay.serviceName;

      const body = paymentLinkOnlySmsBody({
        customerName: row.customer_name,
        salonName: ud.salonName,
        serviceName,
        amountCents: pay.amountCents,
        currency: pay.currency,
        paymentUrl: pay.url,
        bookingReference: ref,
      });

      const sms = await sendBookingSms(normalizedCaller, body);
      if (!sms.ok) {
        return {
          ok: false,
          message: `I booked the pay link on Stripe but the SMS did not go (${sms.detail}). They can ask the salon for the link or pay in person.`,
        };
      }
      ud.sessionFlags.smsSent += 1;
      ud.sessionFlags.paymentLinksSent += 1;
      ud.sessionFlags.linkSent = true;

      return {
        ok: true,
        message: `Payment link texted to ${normalizedCaller} (${pay.currency.toUpperCase()} ${(pay.amountCents / 100).toFixed(2)}). Tell them the link is in a new text from the salon number; they tap it and pay on Stripe. Never ask for card numbers on the call.`,
      };
    },
  });

  /** Uses the caller’s phone from this session — no phone argument (security). */
  readonly listMyBookings = llm.tool({
    description:
      'List this caller’s upcoming confirmed bookings at this salon (matched by the phone they are calling from). Use when they ask to cancel, reschedule, or "what did I book?" before you need a booking reference.',
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const phone = ud.callerPhone.trim();
      if (!phone || phone === 'unknown') {
        return {
          bookings: [],
          message:
            'Could not detect their phone line. Ask them for their booking reference from their confirmation text.',
        };
      }
      const rows = await listUpcomingAppointmentsForCustomer({
        organizationId: ud.organizationId,
        customerPhone: phone,
      });
      if (rows.length === 0) {
        return {
          bookings: [],
          message:
            'No upcoming bookings found for this phone. If they have a confirmation text, ask for the reference code.',
        };
      }
      return {
        bookings: rows.map((r) => ({
          bookingReference: r.bookingReference,
          serviceName: r.serviceName,
          startTime: r.startIso,
          endTime: r.endIso,
        })),
        message: `${rows.length} upcoming booking(s). Use bookingReference with cancelBooking or rescheduleBooking.`,
      };
    },
  });

  readonly cancelBooking = llm.tool({
    description:
      'Cancel an upcoming booking for this caller. Only call **after** they have clearly confirmed they want to cancel. **Your turn must include spoken words in the same message as this tool**—e.g. *"OK—cancelling that now"*—never output **only** this tool with no speech (caller hears long silence). They must be calling from the same number as on the booking. Pass **bookingReference** from their SMS. After the tool returns, confirm cancellation aloud—do not rely on SMS alone.',
    parameters: z.object({
      bookingReference: z
        .string()
        .describe('Reference from the confirmation text, e.g. AB12CD34'),
    }),
    execute: async ({ bookingReference }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const phone = ud.callerPhone.trim();
      if (!phone || phone === 'unknown') {
        return {
          ok: false,
          message: 'Cannot verify their line. Ask them to call from the number on the booking or contact the salon.',
        };
      }
      const result = await cancelAppointmentForCustomer({
        organizationId: ud.organizationId,
        bookingReference,
        customerPhone: phone,
      });
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      const smsBody = bookingCancelledSmsBody({
        customerName: result.customerName,
        salonName: ud.salonName,
        serviceName: result.serviceName,
        bookingReference: result.bookingReference,
      });
      const to = normalizePhoneE164(phone);
      void sendBookingSms(to, smsBody)
        .then((sms) => {
          if (sms.ok) {
            ud.sessionFlags.smsSent += 1;
          } else {
            console.warn('[cancelBooking] SMS failed', sms.detail);
          }
        })
        .catch((e) => console.error('[cancelBooking] SMS error', e));
      return {
        ok: true,
        message: `Cancelled booking ${result.bookingReference} in the diary. A confirmation text is being sent—they should get it shortly. Tell them aloud now that it's cancelled, repeat the reference once, and mention the text—never rely on SMS alone.`,
      };
    },
  });

  readonly rescheduleBooking = llm.tool({
    description:
      'Move an existing booking to a new start time. Always call checkAvailability for the new slot first (same service duration). Caller must be from the phone on the booking.',
    parameters: z.object({
      bookingReference: z.string().describe('Reference from their confirmation text'),
      newDateTime: z.string().describe('New start in ISO-8601 (must match a slot you checked)'),
    }),
    execute: async ({ bookingReference, newDateTime }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const phone = ud.callerPhone.trim();
      if (!phone || phone === 'unknown') {
        return {
          ok: false,
          message: 'Cannot verify their line. Ask them to call from the number on the booking.',
        };
      }
      const result = await rescheduleAppointmentForCustomer({
        organizationId: ud.organizationId,
        bookingReference,
        customerPhone: phone,
        newStartIso: newDateTime,
        businessHours: ud.businessHours,
        timeZone: ud.bookingTimeZone,
      });
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      const smsBody = bookingRescheduledSmsBody({
        customerName: result.customerName,
        salonName: ud.salonName,
        serviceName: result.serviceName,
        bookingReference: result.bookingReference,
        newStart: result.newStart,
      });
      const to = normalizePhoneE164(phone);
      void sendBookingSms(to, smsBody)
        .then((sms) => {
          if (sms.ok) {
            ud.sessionFlags.smsSent += 1;
          } else {
            console.warn('[rescheduleBooking] SMS failed', sms.detail);
          }
        })
        .catch((e) => console.error('[rescheduleBooking] SMS error', e));
      return {
        ok: true,
        message: `Rescheduled ref ${result.bookingReference} to the new time. A text with updated details is being sent. Confirm the new time clearly on the call.`,
      };
    },
  });

  readonly createActionTicket = llm.tool({
    description:
      'Log a follow-up when you cannot fully handle the call: the salon Action Inbox and platform admin are always notified. Use for named staff requests, callbacks you cannot complete, medical/patch test, complaints, catalogue gaps, tool failures, or anything outside your tools. If the caller asked for someone by name, you must still output **spoken assistant text in the same turn** as this tool—the caller must not wait in silence for only this tool. Before calling, confirm what they need and callback number if different from this line. The staffSummary must read like a short note from you (the receptionist) to the team—not a title or keyword list.',
    parameters: z.object({
      staffSummary: z
        .string()
        .min(40)
        .describe(
          'Required: a basic call summary for staff and platform (2–5 short sentences, plain English). Include: what the caller wanted; what you could not do on the call; any names, services, times, or callback preferences they gave. Write full sentences—do not use cryptic phrases like "General query for X" or labels only.',
        ),
      callbackPhone: z
        .string()
        .optional()
        .describe(
          'Callback number if different from this call (Irish national or E.164). Omit if they are happy to be called on the number they are calling from.',
        ),
    }),
    execute: async ({ staffSummary, callbackPhone }, { ctx }) => {
      const ud = readSalonUserData(ctx);
      const phone = callbackPhone?.trim()
        ? normalizePhoneE164(callbackPhone)
        : ud.callerPhone.trim() || 'unknown';
      const text = staffSummary.trim();
      if (!text) {
        return {
          ok: false,
          message:
            'Ask what they need logged for the team, then call createActionTicket with a fuller staffSummary (several sentences).',
        };
      }
      await insertActionTicket({
        organizationId: ud.organizationId,
        callerNumber: phone,
        summary: text,
        engineeringPriority: 'urgent',
      });
      ud.sessionFlags.actionTicketCreated = true;
      console.log('createActionTicket', { organizationId: ud.organizationId, phone });
      return {
        ok: true,
        message:
          'Ticket created for the team. Tell the caller someone will get back to them; do not promise an exact time unless the owner instructions say so.',
      };
    },
  });

  /**
   * Disconnects the caller’s phone leg after a short delay (so your goodbye can play).
   * Requires LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and endCallTarget on session userData.
   */
  readonly endPhoneCall = llm.tool({
    description:
      '**Required** when the caller is done: after **anything else?** and they decline—**invoke this tool** in the **same** turn as your short goodbye. **Never say the words** "end phone call" or the tool name aloud—that is not a hang-up and TTS will read it; only this tool disconnects. **Speech-only goodbye does not hang up.** Plays a hang-up tone and drops the line. Not for mid-booking.',
    parameters: z.object({}),
    execute: async (_args, { ctx }) => {
      const ud = readSalonUserData(ctx);
      return disconnectSalonCallerLeg(
        ctx.session as voice.AgentSession<SalonAgentUserData>,
        ud,
        async () => {
          try {
            await ctx.waitForPlayout();
          } catch (e) {
            console.warn('[endPhoneCall] waitForPlayout', e);
          }
        },
      );
    },
  });

  /** Connect tier includes sendBookingLink; Native tier is in-call booking only. */
  fncCtx(includeBookingLink: boolean) {
    const core = {
      matchServiceFromUtterance: this.matchServiceFromUtterance,
      checkAvailability: this.checkAvailability,
      bookAppointment: this.bookAppointment,
      listMyBookings: this.listMyBookings,
      cancelBooking: this.cancelBooking,
      rescheduleBooking: this.rescheduleBooking,
      sendPaymentLink: this.sendPaymentLink,
      endPhoneCall: this.endPhoneCall,
      createActionTicket: this.createActionTicket,
    };
    return includeBookingLink
      ? { sendBookingLink: this.sendBookingLink, ...core }
      : core;
  }
}
