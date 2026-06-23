# Call transcripts (local mirror)

After each call, the voice worker writes **`latest.md`** here (and a timestamped archive copy).

Pull the latest row from Supabase without placing a call:

```bash
npm run export:latest-call
```

Files in this folder are gitignored — they may contain caller PII. Open `latest.md` in Cursor for agent review.

Optional env: `CARA_TRANSCRIPT_MIRROR_DIR` (worker), `CARA_TRANSCRIPT_ORG_NAME` (export script label).
