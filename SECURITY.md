# Security posture — `cliste-code-base-2`

This service is a **LiveKit Cloud Agent worker** (voice agent). It does not expose
any inbound HTTP endpoints. Public-surface hardening lives in `cliste-code-base-1`
(`SECURITY_CLOUDFLARE.md`).

## Threat model

- **Compromised secrets** → Supabase service-role key, Stripe secret key,
  Twilio API keys, LiveKit API keys.
- **PII leakage** → post-call transcripts contain names, phone numbers,
  occasionally card numbers the caller read out before we redirected them to
  Stripe.
- **Abuse of LLM tool calls** → routing and callback tools run server-side with
  your full service-role credentials, so prompt injection from callers is an
  elevated risk.

## What's in place

| Mitigation | File | Notes |
|---|---|---|
| PII redaction before LLM post-processing and DB insert | `src/lib/gdpr.ts`, `src/lib/call_logs.ts`, `src/lib/action_tickets.ts` | Removes card numbers, CVV, IBANs, PPS numbers, spoken card numbers |
| Phone number masking in logs | `src/lib/gdpr.ts` (`maskPhone`) applied in `src/lib/tools.ts` | Prevents full numbers landing in log pipelines |
| AI / recording disclosure at call open | `src/agent.ts`, `src/lib/greeting_compliance.ts`, `src/lib/ai_disclosure.ts` | Spoken disclosure must complete playout before LiveKit egress starts |
| Call MP3 recording (30-day retention) | `src/lib/call_recording.ts`, `src/agent.ts` | LiveKit egress → Supabase `call-recordings/{orgId}/{callLogId}.mp3` |
| Caller-line classification | `src/lib/phone_classify.ts` | Detects landline vs mobile |
| Tool-level caller verification for payment links | `src/lib/tools.ts` (`sendPaymentLink`) | Refuses to resend a payment link to a number other than the one on file |
| Stripe Checkout Sessions (not card capture by voice) | `src/lib/payments.ts` | Card details never touch the agent or our logs |
| In-process cache for org config | `src/lib/cache.ts`, `src/lib/supabase.ts` | Reduces repeated reads of org + service data |
| GDPR right-to-erasure script | `scripts/gdpr-erase.ts` | Wipes caller PII, deletes recordings |
| GDPR storage-limitation | `cliste-code-base-1` cron `/api/cron/data-retention` | Nulls verbatim transcripts after 30 days |

## LiveKit Cloud Agents checklist

1. **Secrets** — use `lk agent update-secrets` / `--secrets-file`. Never commit
   `secrets.production.env`. LiveKit injects `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
   and `LIVEKIT_API_SECRET` automatically — do not set them as custom secrets.
2. **Region** — production agent runs in **`eu-central`** (Frankfurt). Project
   region pinning should be **Europe (`eu`)** for Irish retail SIP traffic.
3. **Team access** — enforce 2FA on LiveKit Cloud and GitHub deploy approvers.
4. **Deployment logs** — use `lk agent logs`. Phone numbers are masked before
   console output. Do not add new `console.log(phone)` without `maskPhone(...)`.
5. **Rotate keys** — rotate LiveKit API keys quarterly in the LiveKit dashboard.
6. **Local dev** — use `LIVEKIT_AGENT_NAME=cliste-voice-local` so dev workers
   do not steal production dispatches.

See [`docs/livekit-cloud-deploy.md`](docs/livekit-cloud-deploy.md) for deploy commands.

## Operational

- **Rotate `STRIPE_SECRET_KEY` and all third-party API keys** on any suspicion
  of leak.
- **Do not** ship new LLM tools that can read the full caller transcript
  without rerunning redaction on the transcript first.

## Related

- `../cliste-code-base-1/SECURITY_CLOUDFLARE.md` — edge hardening for the
  public-facing Hello Cara dashboard (`https://app.hellocara.ie`).
