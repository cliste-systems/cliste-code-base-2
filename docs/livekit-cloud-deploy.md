# LiveKit Cloud Agents deployment

Production voice worker on **LiveKit Cloud Agents** (`eu-central`, Frankfurt) in project **hellocara**.

## Production identifiers (Sept 2026)

| Resource | ID |
| -------- | -- |
| Project | `hellocara` (`p_4isoiid8ii2`) |
| URL | `wss://hellocara-dfp4tf8y.livekit.cloud` |
| Agent | `CA_B35YRGc9r4Fh` |
| SIP host | `4isoiid8ii2.eu.sip.livekit.cloud` |
| SIP trunk | `ST_qQvnypas9eNp` |
| Dispatch rule | `SDR_AvkCP3skYeGj` → `cliste-retail-node` |

EU data residency: project data region **European Union (Frankfurt)**. Inference region restriction enabled in dashboard.

## Preconditions

1. LiveKit Cloud project **`hellocara`** with EU (Frankfurt) data region
2. Agent compute **`eu-central`** (set on first `lk agent create`)
3. Ship plan ($50/mo) — production agents stay warm 24/7
4. `lk cloud auth` and `lk project set-default hellocara`

## Secrets

```bash
cp secrets.production.env.example secrets.production.env
# Fill from production env / Vercel. Never commit secrets.production.env.
```

Omit `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` — LiveKit Cloud injects these at runtime.

## Deploy

```bash
lk agent deploy --secrets-file secrets.production.env
lk agent status
lk agent logs
lk agent rollback   # if needed
```

CI: [`.github/workflows/deploy-livekit-agent.yml`](../.github/workflows/deploy-livekit-agent.yml)

## Local dev

Keep `LIVEKIT_AGENT_NAME=cliste-voice-local` in `.env` so local workers do not steal production dispatches (`cliste-retail-node`).

## Twilio SIP

Production uses Twilio Elastic SIP Trunk origination → `sip:4isoiid8ii2.eu.sip.livekit.cloud`.

To update Twilio after a project change: [`scripts/update-twilio-livekit-sip.sh`](../scripts/update-twilio-livekit-sip.sh)

## Decommissioned (do not use)

- **Railway** voice worker — removed Sept 2026
- **LiveKit `cliste-salon-test`** (`p_4crcl51h1rh`) — US data region; delete in LiveKit dashboard after cutover
