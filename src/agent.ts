import { Ollama } from 'ollama';
import type { Message, ToolCall } from 'ollama';
import type { Config } from './config.js';
import { TOOLS, TOOL_DEFINITIONS, type DiffLine } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { newSessionId, saveSession, sessionTitle, type Session } from './sessions.js';

const MAX_AGENT_ITERATIONS = 40;
/** How many times per run we re-prompt a model that narrated a tool call without emitting one. */
const MAX_TOOL_CALL_NUDGES = 2;

export interface PermissionRequest {
  toolName: string;
  title: string;
  preview: DiffLine[];
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export interface AgentCallbacks {
  /** Streaming assistant text (full text so far, not a delta). */
  onText: (text: string) => void;
  /** Assistant finished a text block. */
  onTextDone: (text: string) => void;
  /** A tool call is about to run (already approved). */
  onToolStart: (id: number, name: string, title: string) => void;
  /** A tool call finished. */
  onToolEnd: (id: number, name: string, title: string, output: string, isError: boolean, diffLines?: DiffLine[]) => void;
  /** Ask the user to approve a tool call. */
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Status line updates ("thinking", "running tool", ...). */
  onStatus: (status: string) => void;
}

export class Agent {
  private client: Ollama;
  private messages: Message[] = [];
  private sessionAllowed = new Set<string>();
  private aborted = false;
  private nextToolId = 1;
  private nudgesUsed = 0;
  private sessionId = newSessionId();
  private sessionCreatedAt = new Date().toISOString();
  lastTokensPerSec = 0;

  constructor(public config: Config) {
    this.client = new Ollama({ host: config.host });
    this.reset();
  }

  /** Start a fresh conversation (and a fresh session on disk). */
  reset(): void {
    this.messages = [{ role: 'system', content: buildSystemPrompt() }];
    this.sessionId = newSessionId();
    this.sessionCreatedAt = new Date().toISOString();
  }

  /** Continue a previously saved session. */
  restoreSession(session: Session): void {
    this.messages = session.messages;
    // Regenerate the system prompt: environment context (date, files) may be stale
    this.messages[0] = { role: 'system', content: buildSystemPrompt() };
    this.sessionId = session.id;
    this.sessionCreatedAt = session.createdAt;
  }

  /** The conversation so far (including the system prompt). */
  getMessages(): Message[] {
    return this.messages;
  }

  /** Persist the conversation to disk (best-effort, never throws). */
  persistSession(): void {
    saveSession({
      id: this.sessionId,
      cwd: process.cwd(),
      model: this.config.model,
      title: sessionTitle(this.messages),
      createdAt: this.sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      messages: this.messages,
    });
  }

  /** Rough token estimate: ~4 chars per token. */
  estimatedTokens(): number {
    let chars = 0;
    for (const m of this.messages) {
      chars += (m.content?.length ?? 0) + 20;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.round(chars / 4);
  }

  abort(): void {
    this.aborted = true;
    this.client.abort();
  }

  async listModels(): Promise<string[]> {
    const res = await this.client.list();
    return res.models.map((m) => m.name);
  }

  /**
   * Keep the conversation within the context window: truncate old tool
   * outputs first, then drop the oldest turns entirely.
   */
  private prune(): void {
    const budget = this.config.numCtx * 3; // ~chars that fit
    const charCount = () => this.messages.reduce((n, m) => n + (m.content?.length ?? 0) + 50, 0);

    // Truncate tool results outside the last 6 messages
    for (let i = 1; i < this.messages.length - 6 && charCount() > budget; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content.length > 600) {
        m.content = m.content.slice(0, 600) + '\n... [old tool output truncated]';
      }
    }
    // Drop the oldest turns whole. A turn runs from one user message up to (but
    // not including) the next one, so an assistant's tool_calls and their tool
    // results are always removed together — never leaving an orphaned tool
    // result at the front, which produces an invalid message sequence.
    while (charCount() > budget && this.messages.length > 8) {
      let end = 2;
      while (end < this.messages.length && this.messages[end].role !== 'user') end++;
      if (end >= this.messages.length) break; // only one turn left — keep it
      if (this.messages.length - (end - 1) < 8) break; // keep a minimum window
      this.messages.splice(1, end - 1);
    }
  }

  async run(userInput: string, cb: AgentCallbacks): Promise<void> {
    this.aborted = false;
    this.nudgesUsed = 0;
    this.messages.push({ role: 'user', content: userInput });
    try {
      await this.runLoop(cb);
    } finally {
      this.persistSession();
    }
  }

  private async runLoop(cb: AgentCallbacks): Promise<void> {
    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
      this.prune();
      cb.onStatus(iteration === 0 ? 'thinking' : 'working');

      let content = '';
      const toolCalls: ToolCall[] = [];
      try {
        const stream = await this.client.chat({
          model: this.config.model,
          messages: this.messages,
          tools: TOOL_DEFINITIONS,
          stream: true,
          options: {
            num_ctx: this.config.numCtx,
            temperature: this.config.temperature,
          },
          keep_alive: '15m',
        });
        for await (const chunk of stream) {
          if (chunk.message.content) {
            content += chunk.message.content;
            cb.onText(content);
          }
          if (chunk.message.tool_calls) toolCalls.push(...chunk.message.tool_calls);
          if (chunk.done && chunk.eval_count && chunk.eval_duration) {
            this.lastTokensPerSec = Math.round((chunk.eval_count / chunk.eval_duration) * 1e9);
          }
        }
      } catch (err) {
        if (this.aborted || (err as Error).name === 'AbortError') {
          if (content) {
            this.messages.push({ role: 'assistant', content });
            cb.onTextDone(content);
          }
          this.messages.push({ role: 'user', content: '[Interrupted by user]' });
          throw new InterruptedError();
        }
        throw normalizeOllamaError(err, this.config.model);
      }

      // Some local models print tool calls as JSON text instead of using the
      // tool-calling API — recover them from the content.
      if (toolCalls.length === 0 && content) {
        const extracted = extractTextToolCalls(content);
        if (extracted.calls.length > 0) {
          toolCalls.push(...extracted.calls);
          content = extracted.cleaned;
        }
      }

      this.messages.push({
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      if (content) cb.onTextDone(content);
      if (toolCalls.length === 0) {
        // The model produced no runnable tool call. If the text nevertheless
        // looks like a tool call it failed to emit correctly (malformed JSON,
        // Python-style call, plain-text instead of the function interface),
        // don't silently accept it as "done" — nudge the model to re-issue it
        // properly. Bounded so a stubborn model can't loop forever.
        if (this.nudgesUsed < MAX_TOOL_CALL_NUDGES && looksLikeUnexecutedToolCall(content)) {
          this.nudgesUsed++;
          this.messages.push({
            role: 'user',
            content:
              '[Your last message looks like a tool call, but no tool actually ran — it was not emitted through the function-calling interface (or the JSON could not be parsed). Nothing has changed on disk yet. Re-issue the call now as a proper tool call. Do not claim the work is done until a tool has actually run.]',
          });
          cb.onStatus('retrying tool call');
          continue;
        }
        return; // done — model produced a final answer
      }

      for (const call of toolCalls) {
        if (this.aborted) throw new InterruptedError();
        const result = await this.executeToolCall(call, cb);
        this.messages.push({
          role: 'tool',
          content: result,
          tool_name: call.function.name,
        } as Message);
      }
    }
    throw new Error(`Stopped after ${MAX_AGENT_ITERATIONS} tool iterations. Send a message to continue.`);
  }

  private async executeToolCall(call: ToolCall, cb: AgentCallbacks): Promise<string> {
    const name = call.function.name;
    const spec = TOOLS[name];
    const id = this.nextToolId++;
    const args = coerceArgs(call.function.arguments);

    if (!spec) {
      cb.onToolEnd(id, name, name, `Unknown tool: ${name}`, true);
      return `Error: unknown tool "${name}". Available tools: ${Object.keys(TOOLS).join(', ')}`;
    }

    let title: string;
    try {
      title = spec.title(args);
    } catch {
      title = name;
    }

    // Permission gate
    if (!this.config.yolo && !this.sessionAllowed.has(name) && spec.needsPermission(args)) {
      cb.onStatus('waiting for approval');
      let preview: DiffLine[] = [];
      try {
        preview = spec.preview?.(args) ?? [];
      } catch {
        /* ignore preview failures */
      }
      const decision = await cb.onPermission({ toolName: name, title, preview });
      if (decision === 'deny') {
        cb.onToolEnd(id, name, title, 'denied by user', true);
        return 'The user denied this tool call. Ask them how to proceed instead of retrying.';
      }
      if (decision === 'always') this.sessionAllowed.add(name);
    }

    cb.onToolStart(id, name, title);
    cb.onStatus(`running ${name}`);
    try {
      const result = await spec.run(args);
      cb.onToolEnd(id, name, title, result.output, Boolean(result.isError), result.diffLines);
      return result.output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cb.onToolEnd(id, name, title, message, true);
      return `Error: ${message}`;
    }
  }

  /** Summarize the conversation to free up context. */
  async compact(cb: (status: string) => void): Promise<void> {
    cb('compacting conversation');
    const history = this.messages
      .slice(1)
      .map((m) => `${m.role}: ${m.content.slice(0, 1500)}`)
      .join('\n');
    const res = await this.client.chat({
      model: this.config.model,
      messages: [
        {
          role: 'user',
          content: `Summarize this coding session concisely. Keep: the user's goals, decisions made, files created/modified, and any unfinished work.\n\n${history.slice(-30_000)}`,
        },
      ],
      options: { num_ctx: this.config.numCtx },
    });
    // Same conversation, summarized — keep the session id, just replace messages
    this.messages = [{ role: 'system', content: buildSystemPrompt() }];
    this.messages.push({
      role: 'user',
      content: `[Conversation compacted. Summary of the session so far:]\n${res.message.content}`,
    });
    this.messages.push({ role: 'assistant', content: 'Understood — continuing from that summary.' });
    this.persistSession();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalize a tool call's raw `arguments` into a plain object. Ollama's typed
 * API returns an object, but many local models (and the text-recovery path)
 * hand back a JSON-encoded string like `"{\"path\":\"a.py\"}"`. Parse those so
 * the tool actually runs instead of silently receiving empty arguments — which
 * makes the model report a file was written that never got created.
 */
export function coerceArgs(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = lenientJsonParse(trimmed);
    if (isPlainObject(parsed)) return parsed;
  }
  return {};
}

/**
 * Parse JSON, tolerating the small deviations local models produce. Falls back
 * to a trailing-comma-stripped retry (e.g. `{"a":1,}` or `[1,2,]`) so a single
 * stray comma doesn't silently drop an otherwise-valid tool call. Returns
 * `undefined` if the text still isn't valid JSON.
 */
function lenientJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    /* try again after cleaning up common near-miss mistakes */
  }
  try {
    return JSON.parse(s.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

/** Extract a balanced JSON object starting at `start`, respecting strings. */
function scanJsonObject(s: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Recover tool calls that the model wrote as text instead of using the
 * structured tool-calling API. Local models do this in many shapes:
 * ```json fences, <tool_call>/<tool_response> tags, or bare JSON. We scan for
 * any balanced {"name": ..., "arguments": ...} object naming a known tool.
 */
export function extractTextToolCalls(content: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  const ranges: Array<[number, number]> = [];
  // Trigger on the object's first key. Models order keys differently: some put
  // "name" first, others (Hermes/Qwen) emit {"arguments": ..., "name": ...},
  // so we also start scanning on the argument-container keys.
  const starter = /\{\s*"(?:name|tool|function|function_name|arguments|parameters|args)"/g;
  let match: RegExpExecArray | null;
  let scanFrom = 0;
  while ((match = starter.exec(content)) !== null) {
    if (match.index < scanFrom) continue; // inside a previously consumed object
    const json = scanJsonObject(content, match.index);
    if (!json) continue;
    const obj = lenientJsonParse(json);
    if (!isPlainObject(obj)) continue; // not valid JSON — keep scanning
    const fn = isPlainObject(obj.function) ? obj.function : obj;
    const name: unknown = fn.name ?? fn.tool ?? fn.function_name ?? fn.recipient_name;
    if (typeof name !== 'string' || !TOOLS[name]) continue; // not a known tool
    let rawArgs: unknown = fn.arguments ?? fn.parameters ?? fn.args;
    if (rawArgs === undefined) {
      // Flat form: some models drop the "arguments" wrapper and put the
      // parameters as siblings of "name", e.g.
      // {"name": "write_file", "path": "a.txt", "content": "hi"}. Treat the
      // remaining keys as the arguments so the call isn't run with empty args.
      const { name: _n, tool: _t, function_name: _fn, recipient_name: _rn, function: _f, ...rest } = fn;
      rawArgs = rest;
    }
    // Some models emit arguments as a JSON-encoded string rather than an
    // object; coerceArgs parses those so the call still runs.
    if (isPlainObject(rawArgs) || typeof rawArgs === 'string') {
      calls.push({ function: { name, arguments: coerceArgs(rawArgs) } } as ToolCall);
      ranges.push([match.index, match.index + json.length]);
      scanFrom = match.index + json.length;
      starter.lastIndex = scanFrom;
    }
  }
  if (calls.length === 0) return { calls, cleaned: content };

  // Remove the consumed JSON, then any wrapper tags/fences left behind.
  let cleaned = '';
  let pos = 0;
  for (const [start, end] of ranges) {
    cleaned += content.slice(pos, start);
    pos = end;
  }
  cleaned += content.slice(pos);
  cleaned = cleaned
    .replace(/<\/?[a-z_]*(?:tool|function)[a-z_]*>/gi, '')
    .replace(/```(?:json|tool_call|tool_code)?\s*```/g, '')
    .replace(/```(?:json|tool_call|tool_code)?\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { calls, cleaned };
}

/**
 * True if `content` looks like the model *tried* to call a tool but no runnable
 * call could be recovered from it — e.g. malformed JSON, a Python-style
 * `write_file(...)` call, or a tool named in plain text. Used to re-prompt the
 * model instead of silently reporting a task "done" that never touched disk.
 *
 * Deliberately conservative: it only fires when a KNOWN tool name appears in a
 * call-like context, so ordinary final answers that merely mention a tool in
 * prose are not mistaken for failed calls.
 */
export function looksLikeUnexecutedToolCall(content: string): boolean {
  if (!content.trim()) return false;
  const names = Object.keys(TOOLS).join('|');
  // A known tool named as the target of a JSON call: {"name": "write_file", ...}
  const jsonCall = new RegExp(`"(?:name|tool|function_name|recipient_name)"\\s*:\\s*"(?:${names})"`);
  // A known tool invoked Python/JS-style: write_file( ... ). Exclude *definitions*
  // that merely share a tool's name (e.g. `def grep(` or `function bash(` in
  // generated code) so an ordinary final answer isn't mistaken for a failed call.
  const fnCall = new RegExp(`(?<!\\b(?:def|func|fn|function|class|async)\\s+)\\b(?:${names})\\s*\\(`);
  return jsonCall.test(content) || fnCall.test(content);
}

export class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

function normalizeOllamaError(err: unknown, model: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg) && /model/i.test(msg)) {
    return new Error(`Model "${model}" not found. Pull it first: ollama pull ${model}`);
  }
  if (/does not support tools/i.test(msg)) {
    return new Error(`Model "${model}" does not support tool calling. Try qwen2.5-coder, llama3.1, or another tools-capable model.`);
  }
  if (/fetch failed|ECONNREFUSED/i.test(msg)) {
    return new Error('Cannot reach the Ollama server. Is it running? Start it with: ollama serve');
  }
  return err instanceof Error ? err : new Error(msg);
}
