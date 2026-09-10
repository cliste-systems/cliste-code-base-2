# Hello Cara demo line — manual QA checklist

**Number:** +353749389378  
**Baseline call (pre-playbook):** `d42c3254` — good role-play setup, improvised beats 3–4  
**After deploy:** run these paths and compare transcripts in Call Testing.

## Pre-call

- [ ] Worker deployed with conversational demo behaviour (Railway latest commit)
- [ ] Opening: ~1.5s pause, then *"Hello there, you're through to Cara. Who am I speaking with today?"*
- [ ] No duplicate greeting at call start

## Path 0 — Natural opening + conversation first

1. Call **+353749389378** — expect brief pause, then the opening line above
2. Give your name: *"John"*
3. Expect: *"Ah, perfect, John. Just a quick heads-up, this call may be recorded and transcribed. Is that okay with you?"*
4. Say *"Yeah, that's fine"*
5. Expect: *"Great, thanks John. So, how are you keeping today?"*
6. Chat naturally for 2–3 turns (long day, Friday, weather, etc.) — Cara should **acknowledge and react**, not jump to *"How can I assist you?"* or trade menus
7. Only when you steer to product/trade should demos begin

**Fail if:** immediate service question after name, no consent ask, corporate phrases, trade list before conversation

## Path 1 — Electrician trade demo

1. After natural chitchat, say: *"Can we demo an electrician?"*
2. Expect beat 1: chatty ack + one-line value (not a feature list)
3. Expect beat 2: role-play invite with suggested customer line (tripped fuse / need someone out)
4. Role-play as customer: *"My fuse tripped, I need someone today."*
5. Expect beat 3: in-role message-taking + issue/urgency question (no invented prices)
6. Expect beat 4: wrap — *another trade or are you sorted?*
7. Say thanks / goodbye; expect warm close + hangup

**Fail if:** bullet list read aloud, invented caller name, generic capability dump only, no role-play invite

## Path 2 — General (non-trade)

1. After chitchat, say: *"What is Hello Cara?"* or *"What can you do for my business?"*
2. Expect general playbook — not forced into electrician
3. Expect offer to try an example (pick a business or suggested trade)
4. Complete mini demo or short role-play
5. Wrap + close as above

**Fail if:** forced electrician/salon without caller choosing trade

## Path 3 — Explore / audio check

1. Before giving name, say: *"Can you hear me?"*
2. Expect one warm line and a name ask — **not** a second full greeting
3. Complete opening flow (name → consent → how are you keeping)

**Fail if:** repeated full opening, recording notice before name, rushed business pitch

## Diagnostics (Call Testing dashboard)

- [ ] `demo_recording_consent_reply` after name
- [ ] `demo_after_consent_reply` after consent
- [ ] `demo_scenario_start` / `demo_scenario_beat` when trade path begins
- [ ] No transcript issues: corporate assist language, trade menu dump, premature hangup

## Compare to baseline `d42c3254`

| Check | Baseline | Target after playbook |
|-------|----------|------------------------|
| Role-play invite | Yes | Yes (scripted beat 2) |
| In-role reply structure | Generic message-taking | Beat 3 script (issue + urgency) |
| Wrap beat | Improvised / missing | Beat 4 every time |
| Chatty tone | Minimal | Natural Irish conversation first |
