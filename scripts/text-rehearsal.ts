#!/usr/bin/env npx tsx
/**
 * Text rehearsal harness — full Cara worker path without mic/STT.
 *
 * Usage:
 *   npm run text-rehearsal -- --line +353749759508
 *   npm run text-rehearsal -- --line +353749759508 --say "what steaks are on offer"
 *   npm run text-rehearsal -- --line +353749759508 --batch scenarios/retail-offers.yml
 *
 * Requires CARA_TEXT_REHEARSAL=1 and a running worker (`npm run dev`).
 */
import 'dotenv/config';

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Room, RoomEvent } from '@livekit/rtc-node';
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
} from 'livekit-server-sdk';
import { parse as parseYaml } from 'yaml';

import {
  buildTextRehearsalDispatchMetadata,
  buildTextRehearsalRoomName,
  encodeTextRehearsalPacket,
  evaluateTextRehearsalExpectations,
  formatTextRehearsalTranscript,
  isTextRehearsalEnabled,
  parseTextRehearsalPacket,
  TEXT_REHEARSAL_TOPIC,
  type TextRehearsalInboundPacket,
  type TextRehearsalOutboundPacket,
  type TextRehearsalScenario,
  type TextRehearsalScenarioResult,
  type TextRehearsalToolCall,
} from '../src/lib/text_rehearsal.js';

type CliOptions = {
  line: string;
  say: string[];
  batchFile: string | null;
  json: boolean;
  skipGreeting: boolean;
  timeoutMs: number;
  callerNumber: string;
};

function httpsHost(): string {
  const url = process.env.LIVEKIT_URL;
  if (!url) throw new Error('Missing LIVEKIT_URL');
  return url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

function wsUrl(): string {
  const url = process.env.LIVEKIT_URL?.trim();
  if (!url) throw new Error('Missing LIVEKIT_URL');
  return url;
}

function parseArgs(argv: string[]): CliOptions {
  let line = process.env.DEFAULT_ORG_PHONE?.trim() ?? '';
  const say: string[] = [];
  let batchFile: string | null = null;
  let json = false;
  let skipGreeting = false;
  let timeoutMs = 90_000;
  let callerNumber = '+353870000001';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--line' && argv[i + 1]) {
      line = argv[++i]!.trim();
      continue;
    }
    if (arg === '--say' && argv[i + 1]) {
      say.push(argv[++i]!.trim());
      continue;
    }
    if (arg === '--batch' && argv[i + 1]) {
      batchFile = argv[++i]!.trim();
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--skip-greeting') {
      skipGreeting = true;
      continue;
    }
    if (arg === '--timeout' && argv[i + 1]) {
      timeoutMs = Number.parseInt(argv[++i]!, 10);
      continue;
    }
    if (arg === '--caller' && argv[i + 1]) {
      callerNumber = argv[++i]!.trim();
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!line) {
    throw new Error('Missing --line <called-number> (or DEFAULT_ORG_PHONE in .env)');
  }

  return { line, say, batchFile, json, skipGreeting, timeoutMs, callerNumber };
}

function printHelp(): void {
  console.log(`Text rehearsal harness

Options:
  --line <e164>          Called store number (required)
  --say "<text>"         Single caller line (repeatable for multi-turn)
  --batch <file.yml>     Run YAML scenarios
  --skip-greeting        Skip opening greeting playback
  --json                 JSON output for CI assertions
  --timeout <ms>         Per-turn timeout (default 90000)
  --caller <e164>        Simulated caller number (default +353870000001)

Env:
  CARA_TEXT_REHEARSAL=1  Required on the worker
  LIVEKIT_URL/API keys   Same as voice worker
`);
}

function loadScenarios(path: string): TextRehearsalScenario[] {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed = parseYaml(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Batch file must be a YAML list: ${path}`);
  }
  return parsed as TextRehearsalScenario[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

class TextRehearsalClient {
  private room = new Room();
  private pendingTurns = new Map<
    string,
    {
      resolve: (value: {
        assistant: string;
        tools: TextRehearsalToolCall[];
        lines: string[];
      }) => void;
      reject: (error: Error) => void;
      lines: string[];
      tools: TextRehearsalToolCall[];
      assistant: string;
    }
  >();
  private readyPromise: Promise<string | null> | null = null;
  private readyResolve: ((greeting: string | null) => void) | null = null;

  constructor(
    private readonly roomName: string,
    private readonly token: string,
    private readonly url: string,
  ) {}

  async connect(): Promise<void> {
    this.readyPromise = new Promise((resolveReady) => {
      this.readyResolve = resolveReady;
    });

    this.room.on(RoomEvent.DataReceived, (payload, _from, _kind, topic) => {
      if (topic !== TEXT_REHEARSAL_TOPIC) return;
      const packet = parseTextRehearsalPacket(payload);
      if (!packet) return;
      this.handleOutboundPacket(packet);
    });

    await this.room.connect(this.url, this.token, { autoSubscribe: false });
  }

  private handleOutboundPacket(packet: TextRehearsalOutboundPacket): void {
    if (packet.type === 'session_ready') {
      this.readyResolve?.(packet.greeting ?? null);
      this.readyResolve = null;
      return;
    }
    if (packet.type === 'pong') return;

    const pending = this.pendingTurns.get(packet.turnId);
    if (!pending) return;

    if (packet.type === 'assistant_line') {
      pending.lines.push(`Assistant: ${packet.text}`);
      pending.assistant = packet.text;
      return;
    }
    if (packet.type === 'lookup_filler') {
      pending.lines.push(`[lookup filler] ${packet.text}`);
      return;
    }
    if (packet.type === 'tool_call') {
      pending.tools.push({ name: packet.name, args: packet.args });
      pending.lines.push(`[Tool] ${packet.name} ${JSON.stringify(packet.args)}`);
      return;
    }
    if (packet.type === 'turn_complete') {
      pending.resolve({
        assistant: packet.assistant,
        tools: packet.tools,
        lines: pending.lines,
      });
      this.pendingTurns.delete(packet.turnId);
      return;
    }
    if (packet.type === 'error') {
      pending.reject(new Error(packet.message));
      this.pendingTurns.delete(packet.turnId);
    }
  }

  async waitForReady(timeoutMs: number): Promise<string | null> {
    if (!this.readyPromise) throw new Error('Client not connected');
    return Promise.race([
      this.readyPromise,
      sleep(timeoutMs).then(() => {
        throw new Error('Timed out waiting for session_ready');
      }),
    ]);
  }

  async sendTurn(text: string, timeoutMs: number): Promise<{
    assistant: string;
    tools: TextRehearsalToolCall[];
    lines: string[];
  }> {
    const turnId = crypto.randomUUID();
    const resultPromise = new Promise<{
      assistant: string;
      tools: TextRehearsalToolCall[];
      lines: string[];
    }>((resolveTurn, rejectTurn) => {
      this.pendingTurns.set(turnId, {
        resolve: resolveTurn,
        reject: rejectTurn,
        lines: [`Caller: ${text}`],
        tools: [],
        assistant: '',
      });
    });

    const packet: TextRehearsalInboundPacket = {
      type: 'caller_turn',
      text,
      turnId,
    };
    await this.room.localParticipant!.publishData(encodeTextRehearsalPacket(packet), {
      reliable: true,
      topic: TEXT_REHEARSAL_TOPIC,
    });

    return Promise.race([
      resultPromise,
      sleep(timeoutMs).then(() => {
        this.pendingTurns.delete(turnId);
        throw new Error(`Timed out waiting for turn_complete (${text.slice(0, 80)})`);
      }),
    ]);
  }

  async disconnect(): Promise<void> {
    try {
      const packet: TextRehearsalInboundPacket = { type: 'end_session' };
      await this.room.localParticipant?.publishData(encodeTextRehearsalPacket(packet), {
        reliable: true,
        topic: TEXT_REHEARSAL_TOPIC,
      });
    } catch {
      /* best effort */
    }
    await this.room.disconnect();
  }
}

async function createSession(input: {
  line: string;
  callerNumber: string;
  skipGreeting: boolean;
}): Promise<{ roomName: string; token: string; url: string }> {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    throw new Error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
  }

  const host = httpsHost();
  const url = wsUrl();
  const agentName = process.env.LIVEKIT_AGENT_NAME?.trim() || 'cliste-voice-node';
  const roomName = buildTextRehearsalRoomName();
  const metadata = buildTextRehearsalDispatchMetadata({
    calledNumber: input.line,
    callerNumber: input.callerNumber,
    skipGreeting: input.skipGreeting,
  });

  const roomClient = new RoomServiceClient(host, key, secret);
  const dispatchClient = new AgentDispatchClient(host, key, secret);

  await roomClient.createRoom({
    name: roomName,
    metadata,
    emptyTimeout: 120,
    departureTimeout: 30,
    maxParticipants: 4,
  });
  await dispatchClient.createDispatch(roomName, agentName, { metadata });

  const identity = `text-rehearsal-cli-${crypto.randomUUID().slice(0, 8)}`;
  const token = new AccessToken(key, secret, {
    identity,
    name: 'Text rehearsal CLI',
    ttl: '30m',
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: false,
    canSubscribe: false,
    canPublishData: true,
  });

  return { roomName, token: await token.toJwt(), url };
}

async function runConversation(input: {
  line: string;
  turns: string[];
  options: CliOptions;
}): Promise<{ transcript: string[]; toolCalls: TextRehearsalToolCall[] }> {
  const session = await createSession({
    line: input.line,
    callerNumber: input.options.callerNumber,
    skipGreeting: input.options.skipGreeting,
  });
  const client = new TextRehearsalClient(session.roomName, session.token, session.url);
  const transcript: string[] = [];
  const toolCalls: TextRehearsalToolCall[] = [];

  try {
    await client.connect();
    const greeting = await client.waitForReady(input.options.timeoutMs);
    if (greeting && !input.options.skipGreeting) {
      transcript.push(`Assistant: ${greeting}`);
    }

    for (const turn of input.turns) {
      const result = await client.sendTurn(turn, input.options.timeoutMs);
      transcript.push(...result.lines);
      if (result.assistant) {
        transcript.push(`Assistant: ${result.assistant}`);
      }
      toolCalls.push(...result.tools);
    }
  } finally {
    await client.disconnect();
  }

  return { transcript, toolCalls };
}

async function runScenario(
  line: string,
  scenario: TextRehearsalScenario,
  options: CliOptions,
): Promise<TextRehearsalScenarioResult> {
  const { transcript, toolCalls } = await runConversation({
    line,
    turns: scenario.turns,
    options,
  });
  const assistantLines = transcript
    .filter((lineText) => lineText.startsWith('Assistant:'))
    .map((lineText) => lineText.replace(/^Assistant:\s*/, ''));
  const failures = evaluateTextRehearsalExpectations({
    assistantLines,
    toolCalls,
    expect: scenario.expect,
  });
  return {
    name: scenario.name,
    passed: failures.length === 0,
    failures,
    transcript,
  };
}

function printScenarioResult(result: TextRehearsalScenarioResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`\n=== ${result.name} ${result.passed ? 'PASS' : 'FAIL'} ===`);
  for (const line of result.transcript) {
    console.log(line);
  }
  for (const failure of result.failures) {
    console.log(`  ✗ ${failure}`);
  }
}

async function runInteractive(line: string, options: CliOptions): Promise<void> {
  const session = await createSession({
    line,
    callerNumber: options.callerNumber,
    skipGreeting: options.skipGreeting,
  });
  const client = new TextRehearsalClient(session.roomName, session.token, session.url);
  const rl = readline.createInterface({ input, output });

  try {
    await client.connect();
    const greeting = await client.waitForReady(options.timeoutMs);
    if (greeting && !options.skipGreeting) {
      console.log(`Assistant: ${greeting}`);
    }
    console.info(`Text rehearsal on ${line}. Type caller lines (Ctrl+D to exit).`);

    while (true) {
      const text = (await rl.question('Caller> ')).trim();
      if (!text) continue;
      const result = await client.sendTurn(text, options.timeoutMs);
      for (const lineText of result.lines) {
        console.log(lineText);
      }
      if (result.assistant) {
        console.log(`Assistant: ${result.assistant}`);
      }
    }
  } catch {
    /* EOF */
  } finally {
    rl.close();
    await client.disconnect();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!isTextRehearsalEnabled()) {
    console.warn(
      '[text-rehearsal] CARA_TEXT_REHEARSAL is not enabled — set CARA_TEXT_REHEARSAL=1 on the worker before dispatching.',
    );
  }

  if (options.batchFile) {
    const scenarios = loadScenarios(options.batchFile);
    const results: TextRehearsalScenarioResult[] = [];
    for (const scenario of scenarios) {
      const result = await runScenario(options.line, scenario, options);
      results.push(result);
      printScenarioResult(result, options.json);
    }
    const failed = results.filter((result) => !result.passed).length;
    if (options.json) {
      console.log(JSON.stringify({ summary: { total: results.length, failed } }));
    } else {
      console.log(`\nBatch summary: ${results.length - failed}/${results.length} passed`);
    }
    process.exit(failed > 0 ? 1 : 0);
  }

  if (options.say.length > 0) {
    const { transcript, toolCalls } = await runConversation({
      line: options.line,
      turns: options.say,
      options,
    });
    if (options.json) {
      console.log(JSON.stringify({ transcript, toolCalls }));
    } else {
      for (const lineText of transcript) {
        console.log(lineText);
      }
    }
    return;
  }

  await runInteractive(options.line, options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
