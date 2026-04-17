# Security posture — `cliste-code-base-2`

This service is a **LiveKit voice agent worker** running on Railway. It does
not expose any inbound HTTP endpoints, so Cloudflare WAF / DDoS rules do not
apply to it directly — the hardening for public surfaces lives in
`cliste-code-base-1` (see `SECURITY_CLOUDFLARE.md` there).

## Threat model

- **Compromised secrets** → Supabase service-role key, Stripe secret key,
  Twilio API keys, LiveKit API keys.
- **PII leakage** → post-call transcripts contain names, phone numbers,
  occasionally card numbers the caller read out before we redirected them to
  Stripe.
- **Abuse of LLM tool calls** → `bookAppointment`, `sendPaymentLink`, etc.
  The agent runs server-side with your full service-role credentials, so
  prompt injection from callers is an elevated risk.

## What's in place

| Mitigation | File | Notes |
|---|---|---|
| PII redaction before LLM post-processing and DB insert | `src/lib/gdpr.ts`, `src/lib/call_logs.ts`, `src/lib/action_tickets.ts` | Removes card numbers, CVV, IBANs, PPS numbers, spoken card numbers |
| Phone number masking in logs | `src/lib/gdpr.ts` (`maskPhone`) applied in `src/lib/tools.ts` | Prevents full numbers landing in Railway log pipeline / third-party log processors |
| AI / recording disclosure at call open | `src/agent.ts` — `CLISTE_AI_DISCLOSURE_OPENING` / `_TEXT` envs | GDPR Art 13 transparency obligation |
| Caller-line classification | `src/lib/phone_classify.ts` | Detects landline vs mobile; never asks for a mobile if the caller ID already is one |
| Tool-level caller verification for payment links | `src/lib/tools.ts` (`sendPaymentLink`) | Refuses to resend a payment link to a number other than the one on the booking |
| Stripe Checkout Sessions (not card capture by voice) | `src/lib/payments.ts` | Card details never touch the agent or our logs — they go direct to Stripe |
| In-process cache for salon config | `src/lib/cache.ts`, `src/lib/supabase.ts` | Reduces repeated reads of salon + service data |
| GDPR right-to-erasure script | `scripts/gdpr-erase.ts`, `npm run gdpr:erase -- --phone="…"` | Wipes caller PII while preserving the booking row and reference |
| GDPR storage-limitation script | `scripts/gdpr-purge-transcripts.ts`, `npm run gdpr:purge-transcripts -- --days=30` | Nulls verbatim transcripts older than N days |

## Railway checklist

1. **Secrets** — every secret should be a Railway Variable, never checked in.
   Confirm `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_AUTH_TOKEN`,
   `LIVEKIT_API_SECRET` are set as Railway variables and marked sealed.
2. **Team access** — enforce 2FA on every Railway team member. Remove anyone
   who does not need access.
3. **Deployment logs** — Railway retains logs; phone numbers are already
   masked before they reach console. If you ship third-party log drains
   (Datadog/Logtail/etc.), the same masking applies because it runs before
   `console.log`. Don't add new `console.log(phone)` lines without
   `maskPhone(...)`.
4. **Cron** — the GDPR purge script should be wired into a Railway cron (daily
   is fine), using `node scripts/gdpr-purge-transcripts.ts --days=30`.
5. **LiveKit Cloud** — rotate LiveKit API keys once a quarter. Set an expiry
   on each key in the LiveKit dashboard.

## Operational

- **Rotate `STRIPE_SECRET_KEY` and all third-party API keys** on any suspicion
  of leak. Stripe rotation invalidates old test/live keys at the Stripe end.
- **Do not** ship new LLM tools that can read the full caller transcript
  without rerunning redaction on the transcript first. Redaction happens
  once, at the boundary — keep it that way.

## Related

- `../cliste-code-base-1/SECURITY_CLOUDFLARE.md` — edge hardening for the
  public-facing Next.js app.
