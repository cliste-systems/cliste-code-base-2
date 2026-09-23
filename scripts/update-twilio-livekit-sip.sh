#!/usr/bin/env bash
# Update Twilio TwiML bin(s) to point at the new LiveKit EU SIP host.
# Reads TWILIO_* from cb2 .env and SIP host from .livekit-migration.env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .livekit-migration.env ]]; then
  # shellcheck disable=SC1091
  source .livekit-migration.env
fi

if [[ -z "${LIVEKIT_SIP_HOST:-}" ]]; then
  LIVEKIT_SIP_HOST="4isoiid8ii2.eu.sip.livekit.cloud"
fi

# Load Twilio creds
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source <(rg '^TWILIO_ACCOUNT_SID=|^TWILIO_AUTH_TOKEN=' .env)
fi

SID="${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID missing}"
TOKEN="${TWILIO_AUTH_TOKEN:?TWILIO_AUTH_TOKEN missing}"

# Primary TwiML bin used by TWILIO_IE_VOICE_URL in Vercel
TWIML_BIN_SID="${TWILIO_TWIML_BIN_SID:-EHa3736f72d7100e77c0728e6de59fa872}"

build_twiml() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="60" answerOnBridge="true">
    <Sip>sip:{{To}}@${LIVEKIT_SIP_HOST};transport=tcp</Sip>
  </Dial>
</Response>
EOF
}

# Default bin used by TWILIO_IE_VOICE_URL in Vercel (handler.twilio.com/twiml/…)
TWIML_BIN_SID="${TWILIO_TWIML_BIN_SID:-EHa3736f72d7100e77c0728e6de59fa872}"

TWIML_CONTENT="$(build_twiml)"

echo "Updating TwiML bin $TWIML_BIN_SID → sip:{{To}}@${LIVEKIT_SIP_HOST}"

curl -sf -u "$SID:$TOKEN" \
  "https://twilio.com/2010-04-01/Accounts/$SID/Applications/$TWIML_BIN_SID.json" \
  >/dev/null 2>&1 || true

# TwiML Bins API (Studio/TwiML Bins use different endpoint)
HTTP_CODE=$(curl -s -o /tmp/twiml-resp.txt -w "%{http_code}" -u "$SID:$TOKEN" \
  -X POST "https://twilio.com/2010-04-01/Accounts/$SID/TwimlBins/$TWIML_BIN_SID" \
  --data-urlencode "FriendlyName=LiveKit EU inbound" \
  --data-urlencode "Content=$TWIML_CONTENT")

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "TwiML Bins API returned $HTTP_CODE — trying legacy TwiML Bin URL handler update via Content API..."
  # Some accounts use handler.twilio.com/twiml/{Sid} — update via Twilio Console if this fails.
  cat /tmp/twiml-resp.txt
  echo
  echo "Manual fallback: Twilio Console → TwiML Bins → update Content to:"
  echo "$TWIML_CONTENT"
  exit 1
fi

echo "Twilio TwiML bin updated."
