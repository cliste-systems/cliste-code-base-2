import Stripe from 'stripe';

/**
 * Stripe platform client for the voice agent.
 *
 * This worker speaks to the **same** Stripe platform account used by
 * `cliste-code-base-1` (the salon web app). Payments for AI-call bookings
 * flow through **Stripe Connect destination charges** — the charge lands on
 * Cliste's platform account and Stripe automatically transfers the net to the
 * salon's Express connected account, keeping `CLISTE_STRIPE_APPLICATION_FEE_BPS`
 * (default 500 = 5%) as our platform fee.
 *
 * Webhook-driven state updates (`payment_status='paid'`, refunds, etc.) are
 * handled entirely by the web app's `/api/stripe/webhook` route — this
 * worker only **creates** Checkout Sessions and sends the link over SMS.
 */
let cachedClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cachedClient) {
    return cachedClient;
  }
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set — the voice agent cannot send payment links.',
    );
  }
  cachedClient = new Stripe(secret, {
    // Pin the same API version the web app uses so destination-charge behaviour
    // stays consistent across both codebases.
    apiVersion: '2026-03-25.dahlia',
    typescript: true,
    appInfo: {
      name: 'Cliste Systems Voice Agent',
      url: 'https://clistesystems.ie',
    },
  });
  return cachedClient;
}

export function stripeIsConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/**
 * Cliste's platform fee in basis points (500 = 5.00%). Can be overridden per
 * deployment via `CLISTE_STRIPE_APPLICATION_FEE_BPS`.
 *
 * Kept identical to `cliste-code-base-1/src/lib/stripe.ts` so public bookings
 * and AI-call bookings charge the same fee.
 */
export function getApplicationFeeBps(): number {
  const raw = process.env.CLISTE_STRIPE_APPLICATION_FEE_BPS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5000) {
    return 500;
  }
  return parsed;
}

export function getDefaultCurrency(): string {
  const raw = process.env.CLISTE_STRIPE_CURRENCY?.trim().toLowerCase();
  if (!raw) {
    return 'eur';
  }
  if (!/^[a-z]{3}$/.test(raw)) {
    return 'eur';
  }
  return raw;
}

/** Rounds a decimal amount (e.g. 40.00) into minor units (4000). */
export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) {
    return 0;
  }
  return Math.round(amount * 100);
}

export function computeApplicationFeeCents(
  amountCents: number,
  feeBps: number = getApplicationFeeBps(),
): number {
  if (amountCents <= 0 || feeBps <= 0) {
    return 0;
  }
  return Math.min(amountCents, Math.floor((amountCents * feeBps) / 10_000));
}

/**
 * Base URL the customer lands on after Stripe Checkout. Points at the salon
 * storefront running in `cliste-code-base-1` (so they see the branded
 * `/[salonSlug]/booking/success` page, not a bare Stripe page).
 */
export function resolveBookingSiteOrigin(): string {
  const raw =
    process.env.CLISTE_BOOKING_SITE_URL?.trim() ||
    process.env.BOOKING_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    '';
  if (!raw) {
    return 'https://book.clistesystems.ie';
  }
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://book.clistesystems.ie';
  }
}
