import { getSupabaseClient } from './supabase.js';
import {
  computeApplicationFeeCents,
  getDefaultCurrency,
  getStripeClient,
  resolveBookingSiteOrigin,
  toMinorUnits,
} from './stripe.js';

/**
 * Create a Stripe Checkout Session for an *already-booked* appointment so the
 * voice agent can SMS the customer a pay-online link. Uses **destination
 * charges** on the platform account so the net amount transfers to the
 * salon's connected Express account, minus Cliste's application fee.
 *
 * This mirrors the `createBookingPaymentIntent` flow in `cliste-code-base-1`
 * but uses Checkout Sessions (better fit for pay-by-SMS-link UX — the
 * customer taps the SMS, lands on Stripe's hosted form which already supports
 * Apple Pay / Google Pay without extra domain verification).
 *
 * The web app's `/api/stripe/webhook` route picks up the
 * `checkout.session.completed` event via `metadata.appointment_id` and flips
 * `payment_status='paid'`. This worker only *creates* the session.
 */

export type AppointmentPaymentResult =
  | {
      ok: true;
      url: string;
      sessionId: string;
      paymentIntentId: string | null;
      amountCents: number;
      currency: string;
      serviceName: string;
      salonName: string;
    }
  | { ok: false; reason: PaymentFailureReason; message: string };

export type PaymentFailureReason =
  | 'not_configured'
  | 'not_onboarded'
  | 'no_price'
  | 'appointment_missing'
  | 'already_paid'
  | 'stripe_error';

type AppointmentRow = {
  id: string;
  organization_id: string;
  service_id: string;
  customer_phone: string;
  customer_name: string;
  booking_reference: string;
  start_time: string;
  payment_status: string | null;
  services: {
    name: string;
    price: unknown;
  } | Array<{ name: string; price: unknown }> | null;
  organization: {
    id: string;
    name: string | null;
    slug: string | null;
    stripe_account_id: string | null;
    stripe_charges_enabled: boolean | null;
    application_fee_bps: number | null;
  } | Array<{
    id: string;
    name: string | null;
    slug: string | null;
    stripe_account_id: string | null;
    stripe_charges_enabled: boolean | null;
    application_fee_bps: number | null;
  }> | null;
};

/**
 * Fetch an appointment row with everything we need to price + route payment
 * to the correct connected account. Returns `null` when not found so callers
 * can distinguish between transient errors (thrown) and lookup misses.
 */
async function loadAppointmentForPayment(
  appointmentId: string,
): Promise<AppointmentRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `id, organization_id, service_id, customer_phone, customer_name,
       booking_reference, start_time, payment_status,
       services ( name, price ),
       organization:organizations ( id, name, slug, stripe_account_id, stripe_charges_enabled, application_fee_bps )`,
    )
    .eq('id', appointmentId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as AppointmentRow | null) ?? null;
}

/** Supabase-js sometimes returns joined rows as arrays; normalise. */
function firstJoined<T>(v: T | T[] | null | undefined): T | null {
  if (!v) {
    return null;
  }
  if (Array.isArray(v)) {
    return (v[0] as T) ?? null;
  }
  return v;
}

function parsePriceToNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

/**
 * Create a Checkout Session for the given appointment and persist the payment
 * metadata (`payment_status='pending'`, amount/fee/currency, Stripe IDs). The
 * caller is expected to SMS `result.url` to the customer.
 */
export async function createBookingCheckoutSession(
  appointmentId: string,
): Promise<AppointmentPaymentResult> {
  const appt = await loadAppointmentForPayment(appointmentId);
  if (!appt) {
    return {
      ok: false,
      reason: 'appointment_missing',
      message: 'I could not find that booking to attach a payment link to.',
    };
  }

  if (appt.payment_status === 'paid') {
    return {
      ok: false,
      reason: 'already_paid',
      message: 'That booking is already marked paid — no need to text a link.',
    };
  }

  const service = firstJoined(appt.services);
  const org = firstJoined(appt.organization);

  if (!service || !org) {
    return {
      ok: false,
      reason: 'appointment_missing',
      message: 'Booking is missing service or salon details — cannot charge.',
    };
  }

  if (!org.stripe_account_id || !org.stripe_charges_enabled) {
    return {
      ok: false,
      reason: 'not_onboarded',
      message:
        'This salon has not finished Stripe onboarding yet, so I cannot take an online payment. They can pay in person.',
    };
  }

  const priceEur = parsePriceToNumber(service.price);
  if (priceEur == null || priceEur <= 0) {
    return {
      ok: false,
      reason: 'no_price',
      message:
        'This service does not have a set price, so I cannot charge for it online — they can settle in person.',
    };
  }

  const amountCents = toMinorUnits(priceEur);
  const currency = getDefaultCurrency();
  const feeCents = computeApplicationFeeCents(
    amountCents,
    typeof org.application_fee_bps === 'number' ? org.application_fee_bps : undefined,
  );

  const origin = resolveBookingSiteOrigin();
  const slug =
    org.slug && /^[a-z0-9-]+$/.test(org.slug.trim().toLowerCase())
      ? org.slug.trim().toLowerCase()
      : null;
  const refParam = encodeURIComponent(appt.booking_reference);
  const successUrl = slug
    ? `${origin}/${slug}/booking/success?ref=${refParam}&sid={CHECKOUT_SESSION_ID}`
    : `${origin}/booking/success?ref=${refParam}&sid={CHECKOUT_SESSION_ID}`;
  const cancelUrl = slug
    ? `${origin}/${slug}?payment=cancelled&ref=${refParam}`
    : `${origin}/?payment=cancelled&ref=${refParam}`;

  const salonName = org.name?.trim() || 'your salon';
  const serviceName = service.name?.trim() || 'Appointment';

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Stripe requires success_url for `mode: 'payment'` Checkout Sessions.
      // Without it the API 400s with `parameter_missing: success_url` and the
      // agent apologises on-call. cancel_url is optional but pairs naturally.
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amountCents,
            product_data: {
              name: serviceName,
              description: `Booking at ${salonName} (ref ${appt.booking_reference})`,
            },
          },
        },
      ],
      payment_intent_data: {
        application_fee_amount: feeCents,
        transfer_data: { destination: org.stripe_account_id },
        statement_descriptor_suffix:
          salonName.replace(/[^a-z0-9 ]/gi, '').slice(0, 22) || 'CLISTE',
        metadata: {
          appointment_id: appt.id,
          organization_id: appt.organization_id,
          booking_reference: appt.booking_reference,
          source: 'ai_call',
        },
      },
      // Mirrored on the Session so `checkout.session.completed` can route to
      // the right appointment without re-expanding the PaymentIntent.
      metadata: {
        appointment_id: appt.id,
        organization_id: appt.organization_id,
        booking_reference: appt.booking_reference,
        source: 'ai_call',
      },
      // 24h grace so a customer who pays later in the day still completes.
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });

    if (!session.url) {
      return {
        ok: false,
        reason: 'stripe_error',
        message: 'Stripe did not return a payment link URL.',
      };
    }

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);

    // Persist pending payment so the dashboard payments list shows it
    // immediately, and so `checkout.session.expired` / other webhook events
    // have a row to match against.
    const supabase = getSupabaseClient();
    const { error: updateErr } = await supabase
      .from('appointments')
      .update({
        payment_status: 'pending',
        amount_cents: amountCents,
        platform_fee_cents: feeCents,
        currency,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
      })
      .eq('id', appt.id);
    if (updateErr) {
      // Best-effort warning; the session is already created on Stripe and
      // the webhook will still mark the booking paid via metadata lookup.
      console.error(
        '[payments] could not persist pending payment state',
        updateErr,
      );
    }

    return {
      ok: true,
      url: session.url,
      sessionId: session.id,
      paymentIntentId,
      amountCents,
      currency,
      serviceName,
      salonName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payments] Stripe checkout.sessions.create failed', err);
    return {
      ok: false,
      reason: 'stripe_error',
      message,
    };
  }
}

/**
 * Customer-facing SMS body that bundles the booking confirmation with the pay
 * link. Used when the caller chose "pay online" during the call — one text,
 * not two.
 */
export function bookingPaymentSmsBody(input: {
  customerName: string;
  salonName: string;
  serviceName: string;
  start: Date;
  bookingReference: string;
  amountCents: number;
  currency: string;
  paymentUrl: string;
  timeZone: string;
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] || 'there';
  let when: string;
  try {
    when = input.start.toLocaleString('en-IE', {
      timeZone: input.timeZone,
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
  const price = formatMoney(input.amountCents, input.currency);
  return `Hi ${first}, your booking at ${input.salonName} is confirmed: ${input.serviceName} on ${when} (ref ${input.bookingReference}). Pay ${price} securely here: ${input.paymentUrl} — ${input.salonName}`;
}

/** Follow-up SMS when the agent sends just a payment link after a prior confirmation text. */
export function paymentLinkOnlySmsBody(input: {
  customerName: string;
  salonName: string;
  serviceName: string;
  amountCents: number;
  currency: string;
  paymentUrl: string;
  bookingReference: string;
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] || 'there';
  const price = formatMoney(input.amountCents, input.currency);
  return `Hi ${first}, here is the secure payment link for your ${input.serviceName} at ${input.salonName} (ref ${input.bookingReference}): pay ${price} → ${input.paymentUrl}`;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
