/**
 * End-to-end tests of the agent loop against a mock Ollama server.
 *
 * The mock speaks just enough of the /api/chat protocol (NDJSON streaming and
 * plain JSON) to script multi-turn conversations: tool calls, permission
 * prompts, errors, and aborts — no real model needed.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Sessions persist under $HOME — point HOME at a sandbox BEFORE loading src modules,
// so tests never touch the real ~/.local/share/vibe.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
process.env.HOME = fakeHome;

const { Agent, InterruptedError } = await import('../src/agent.js');
const { DEFAULT_CONFIG } = await import('../src/config.js');
type AgentT = InstanceType<typeof Agent>;
type Chunk = Record<string, unknown>;

// --- mock Ollama ----------------------------------------------------------------

const DONE: Chunk = {
  model: 'mock',
  created_at: new Date().toISOString(),
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  eval_count: 5,
  eval_duration: 1_000_000_000,
};

function textReply(text: string): Chunk[] {
  return [{ ...DONE, done: false, message: { role: 'assistant', content: text } }, DONE];
}

function toolCallReply(name: string, args: Record<string, unknown>, content = ''): Chunk[] {
  return [
    { ...DONE, done: false, message: { role: 'assistant', content, tool_calls: [{ function: { name, arguments: args } }] } },
    DONE,
  ];
}

type Turn = Chunk[] | ((body: Record<string, unknown>) => Chunk[]) | { status: number; error: string } | 'hang';

class MockOllama {
  server: http.Server;
  requests: Array<Record<string, unknown>> = [];
  private script: Turn[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        this.requests.push(parsed);
        const turn = this.script.length > 1 ? this.script.shift()! : this.script[0];
        if (turn === 'hang') {
          // emit one token then keep the connection open (for abort tests)
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(JSON.stringify({ ...DONE, done: false, message: { role: 'assistant', content: 'thinking…' } }) + '\n');
          return;
        }
        if (typeof turn === 'object' && !Array.isArray(turn)) {
          res.writeHead(turn.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: turn.error }));
          return;
        }
        const chunks = typeof turn === 'function' ? turn(parsed) : turn;
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const c of chunks) res.write(JSON.stringify(c) + '\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(chunks.at(-1)?.done ? { ...chunks.at(-2), done: true } : chunks[0]));
        }
      });
    });
  }

  async start(script: Turn[]): Promise<string> {
    this.script = script;
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}

// --- harness ---------------------------------------------------------------------

interface Recorded {
  textDone: string[];
  tools: Array<{ name: string; output: string; isError: boolean }>;
  permissionAsks: string[];
}

function recordCallbacks(onPermission: 'allow' | 'always' | 'deny' = 'allow') {
  const events: Recorded = { textDone: [], tools: [], permissionAsks: [] };
  return {
    events,
    callbacks: {
      onText: () => {},
      onTextDone: (t: string) => events.textDone.push(t),
      onToolStart: () => {},
      onToolEnd: (_id: number, name: string, _title: string, output: string, isError: boolean) =>
        events.tools.push({ name, output, isError }),
      onPermission: async (req: { title: string }) => {
        events.permissionAsks.push(req.title);
        return onPermission;
      },
      onStatus: () => {},
    },
  };
}

let mock: MockOllama;
let workspace: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ws-'));
  process.chdir(workspace);
  mock = new MockOllama();
});

afterEach(() => {
  mock.stop();
  process.chdir(originalCwd);
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function makeAgent(script: Turn[], yolo = true): Promise<AgentT> {
  const host = await mock.start(script);
  return new Agent({ ...DEFAULT_CONFIG, model: 'mock', host, numCtx: 8192, yolo });
}

// --- tests -------------------------------------------------------------------------

test('runs a tool call, feeds the result back, and finishes with the final answer', async () => {
  const agent = await makeAgent([
    toolCallReply('write_file', { path: 'hello.py', content: 'print("Hello World")\n' }),
    textReply('Created hello.py — all done!'),
  ]);
  const { events, callbacks } = recordCallbacks();
  await agent.run('write a hello world in hello.py', callbacks);

  assert.equal(fs.readFileSync(path.join(workspace, 'hello.py'), 'utf8'), 'print("Hello World")\n');
  assert.deepEqual(events.textDone.at(-1), 'Created hello.py — all done!');
  assert.equal(events.tools[0].name, 'write_file');
  assert.equal(events.tools[0].isError, false);

  // second request must contain the tool result for the model to read
  const secondTurn = mock.requests[1].messages as Array<{ role: string; content: string }>;
  const toolMsg = secondTurn.find((m) => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.content.includes('Created'), 'tool output is sent back to the model');

  // conversation shape: system, user, assistant(tool call), tool, assistant
  const roles = agent.getMessages().map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant']);
});

test('persists the session to disk under $HOME after a run', async () => {
  const agent = await makeAgent([textReply('hi!')]);
  const { callbacks } = recordCallbacks();
  await agent.run('hello session-persist-check', callbacks);
  const sessionsDir = path.join(fakeHome, '.local', 'share', 'vibe', 'sessions');
  const saved = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
  assert.ok(saved.some((s) => s.title === 'hello session-persist-check'));
});

test('recovers tool calls the model printed as text instead of using the API', async () => {
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'file-content-here');
  const agent = await makeAgent([
    textReply('Let me look:\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```'),
    textReply('The file says file-content-here.'),
  ]);
  const { events, callbacks } = recordCallbacks();
  await agent.run('what is in a.txt?', callbacks);

  assert.equal(events.tools[0]?.name, 'read_file');
  assert.ok(events.tools[0].output.includes('file-content-here'));
  assert.equal(events.textDone.at(-1), 'The file says file-content-here.');
});

test('denied permission blocks the tool and tells the model', async () => {
  const agent = await makeAgent(
    [toolCallReply('bash', { command: 'rm -rf important' }), textReply('Understood, I will not.')],
    false, // yolo off
  );
  const { events, callbacks } = recordCallbacks('deny');
  await agent.run('clean up', callbacks);

  assert.equal(events.permissionAsks.length, 1);
  assert.equal(events.tools[0].isError, true);
  const secondTurn = mock.requests[1].messages as Array<{ role: string; content: string }>;
  const toolMsg = secondTurn.find((m) => m.role === 'tool');
  assert.ok(toolMsg && /denied/.test(toolMsg.content));
});

test('"always" approves the whole session: no second prompt for the same tool', async () => {
  const agent = await makeAgent(
    [
      toolCallReply('write_file', { path: 'one.txt', content: '1' }),
      toolCallReply('write_file', { path: 'two.txt', content: '2' }),
      textReply('both written'),
    ],
    false, // yolo off
  );
  const { events, callbacks } = recordCallbacks('always');
  await agent.run('write two files', callbacks);

  assert.equal(events.permissionAsks.length, 1, 'second write_file call must not prompt again');
  assert.ok(fs.existsSync(path.join(workspace, 'one.txt')));
  assert.ok(fs.existsSync(path.join(workspace, 'two.txt')));
});

test('safe read-only tools run without any permission prompt even without yolo', async () => {
  const agent = await makeAgent(
    [toolCallReply('list_dir', {}), textReply('empty dir')],
    false, // yolo off
  );
  const { events, callbacks } = recordCallbacks('deny'); // would fail the run if asked
  await agent.run('what files are here?', callbacks);
  assert.equal(events.permissionAsks.length, 0);
  assert.equal(events.tools[0].name, 'list_dir');
  assert.equal(events.tools[0].isError, false);
});

test('stops with a clear error after the iteration cap instead of looping forever', async () => {
  const agent = await makeAgent([toolCallReply('list_dir', {})]); // same reply forever
  const { callbacks } = recordCallbacks();
  await assert.rejects(agent.run('loop', callbacks), /Stopped after 40 tool iterations/);
});

test('unknown tool names get an actionable error instead of crashing', async () => {
  const agent = await makeAgent([
    toolCallReply('teleport_files', { to: 'mars' }),
    textReply('sorry, wrong tool'),
  ]);
  const { events, callbacks } = recordCallbacks();
  await agent.run('go', callbacks);
  assert.equal(events.tools[0].isError, true);
  const secondTurn = mock.requests[1].messages as Array<{ role: string; content: string }>;
  const toolMsg = secondTurn.find((m) => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.content.includes('Available tools:'));
});

test('a missing model produces a "pull it first" hint', async () => {
  const agent = await makeAgent([{ status: 404, error: 'model "mock" not found, try pulling it first' }]);
  const { callbacks } = recordCallbacks();
  await assert.rejects(agent.run('hi', callbacks), /ollama pull mock/);
});

test('an unreachable server produces a "start ollama" hint', async () => {
  // grab a port that is definitely closed
  const probe = new MockOllama();
  const host = await probe.start([]);
  probe.stop();
  const agent = new Agent({ ...DEFAULT_CONFIG, model: 'mock', host, numCtx: 8192, yolo: true });
  const { callbacks } = recordCallbacks();
  await assert.rejects(agent.run('hi', callbacks), /Is it running/);
});

test('abort mid-stream raises InterruptedError and marks the conversation', async () => {
  const agent = await makeAgent(['hang']);
  const { callbacks } = recordCallbacks();
  const interrupting = {
    ...callbacks,
    onText: () => setTimeout(() => agent.abort(), 10), // interrupt once tokens start flowing
  };
  await assert.rejects(agent.run('think forever', interrupting), InterruptedError);
  assert.equal(agent.getMessages().at(-1)?.content, '[Interrupted by user]');
});

test('compact replaces the conversation with a summary but keeps the session going', async () => {
  const agent = await makeAgent([
    textReply('the answer is 42'),
    textReply('SUMMARY: user asked about the answer; it is 42.'),
  ]);
  const { callbacks } = recordCallbacks();
  await agent.run('what is the answer?', callbacks);
  await agent.compact(() => {});

  const messages = agent.getMessages();
  assert.equal(messages[0].role, 'system');
  assert.ok(messages.some((m) => m.content.includes('SUMMARY: user asked about the answer')));
  assert.ok(agent.estimatedTokens() > 0);
});
