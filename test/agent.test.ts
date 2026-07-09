import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from 'ollama';
import { Agent, coerceArgs, extractTextToolCalls, looksLikeUnexecutedToolCall } from '../src/agent.js';
import { DEFAULT_CONFIG } from '../src/config.js';

test('ignores plain text with no tool calls', () => {
  const { calls, cleaned } = extractTextToolCalls('Here is how you can fix the bug in `app.ts`.');
  assert.equal(calls.length, 0);
  assert.equal(cleaned, 'Here is how you can fix the bug in `app.ts`.');
});

test('extracts a bare JSON tool call', () => {
  const { calls, cleaned } = extractTextToolCalls('{"name": "read_file", "arguments": {"path": "src/app.ts"}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'src/app.ts' });
  assert.equal(cleaned, '');
});

test('extracts a tool call inside a ```json fence', () => {
  const content = 'Let me read that file.\n```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.ok(cleaned.includes('Let me read that file.'));
  assert.ok(!cleaned.includes('read_file'));
});

test('extracts a tool call inside <tool_call> tags', () => {
  const content = '<tool_call>\n{"name": "list_dir", "arguments": {"path": "."}}\n</tool_call>';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'list_dir');
  assert.equal(cleaned, '');
});

test('handles the {"function": {...}} wrapper shape', () => {
  const content = '{"function": {"name": "glob", "arguments": {"pattern": "**/*.ts"}}}';
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'glob');
  assert.deepEqual(calls[0].function.arguments, { pattern: '**/*.ts' });
});

test('accepts "parameters" as an alias for arguments', () => {
  const { calls } = extractTextToolCalls('{"name": "grep", "parameters": {"pattern": "TODO"}}');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].function.arguments, { pattern: 'TODO' });
});

test('ignores JSON naming an unknown tool', () => {
  const content = '{"name": "rm_rf_everything", "arguments": {}}';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 0);
  assert.equal(cleaned, content);
});

test('handles braces and escaped quotes inside string arguments', () => {
  const args = { path: 'a.ts', old_string: 'if (x) { return "y\\"z"; }', new_string: 'return { ok: true };' };
  const content = `{"name": "edit_file", "arguments": ${JSON.stringify(args)}}`;
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].function.arguments, args);
});

test('extracts multiple tool calls and keeps surrounding prose', () => {
  const content =
    'First:\n{"name": "read_file", "arguments": {"path": "a"}}\nthen:\n{"name": "read_file", "arguments": {"path": "b"}}\ndone.';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => (c.function.arguments as { path: string }).path),
    ['a', 'b'],
  );
  assert.ok(cleaned.includes('First:'));
  assert.ok(cleaned.includes('done.'));
});

test('does not treat unrelated JSON in prose as a tool call', () => {
  const content = 'Set your config to {"name": "my-app", "version": "1.0.0"} and restart.';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 0);
  assert.equal(cleaned, content);
});

test('ignores unbalanced/truncated JSON', () => {
  const content = '{"name": "read_file", "arguments": {"path": "a.txt"';
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 0);
});

test('accepts the {"tool": ..., "args": ...} shape some models emit', () => {
  const { calls } = extractTextToolCalls('{"tool": "list_dir", "args": {"path": "src"}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'list_dir');
  assert.deepEqual(calls[0].function.arguments, { path: 'src' });
});

test('recovers a call whose arguments are a JSON-encoded string', () => {
  // Some local models emit arguments as a string, not an object. Previously
  // this was dropped, so the model reported writing a file that never got
  // created. The arguments must be parsed so the tool actually runs.
  const content = '{"name": "write_file", "arguments": "{\\"path\\": \\"a.py\\", \\"content\\": \\"print(1)\\"}"}';
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'write_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'a.py', content: 'print(1)' });
});

test('coerceArgs normalizes object, string, and invalid arguments', () => {
  assert.deepEqual(coerceArgs({ path: 'x' }), { path: 'x' });
  assert.deepEqual(coerceArgs('{"path":"x"}'), { path: 'x' });
  assert.deepEqual(coerceArgs(''), {});
  assert.deepEqual(coerceArgs('not json'), {});
  assert.deepEqual(coerceArgs('[1,2]'), {}); // arrays are not valid tool args
  assert.deepEqual(coerceArgs(null), {});
});

test('recovers a call when "name" comes after "arguments" (Hermes/Qwen order)', () => {
  // Hermes/Qwen-style models emit {"arguments": ..., "name": ...}. The starter
  // must not assume "name" is the first key, or these calls are dropped.
  const { calls } = extractTextToolCalls('{"arguments": {"path": "a.ts"}, "name": "read_file"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'a.ts' });
});

test('recovers an args-first call wrapped in <tool_call> tags', () => {
  const content = '<tool_call>\n{"arguments": {"path": "a.ts"}, "name": "read_file"}\n</tool_call>';
  const { calls, cleaned } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(cleaned, '');
});

test('accepts the "function_name" key some models emit', () => {
  const { calls } = extractTextToolCalls('{"function_name": "list_dir", "arguments": {"path": "src"}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'list_dir');
});

test('ignores JSON objects that do not name a known tool', () => {
  // Broadening the starter to "arguments" must not turn arbitrary prose JSON
  // into tool calls.
  assert.equal(extractTextToolCalls('config: {"arguments": {"x": 1}, "port": 8080}').calls.length, 0);
  assert.equal(extractTextToolCalls('{"name": "delete_everything", "arguments": {}}').calls.length, 0);
});

test('recovers a call with a trailing comma in its arguments', () => {
  // Local models at temperature occasionally emit a stray trailing comma.
  // Previously JSON.parse failed and the whole call was silently dropped, so
  // the model reported writing a file that never got created.
  const content = '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi",}}';
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'write_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'a.txt', content: 'hi' });
});

test('recovers a flat call whose parameters are siblings of "name"', () => {
  // Some models drop the "arguments" wrapper: {"name": "write_file", "path": ...}.
  // Without recovery the tool ran with empty args and failed.
  const content = '{"name": "write_file", "path": "a.txt", "content": "hi"}';
  const { calls } = extractTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'write_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'a.txt', content: 'hi' });
});

test('flat-arg recovery does not turn unrelated prose JSON into a call', () => {
  assert.equal(extractTextToolCalls('Set your config to {"name": "my-app", "version": "1.0.0"}.').calls.length, 0);
});

test('looksLikeUnexecutedToolCall detects failed/narrated tool calls', () => {
  // JSON naming a known tool, but not recoverable as a call
  assert.ok(looksLikeUnexecutedToolCall('{"name": "write_file", "arguments": {malformed'));
  // Python-style call the model wrote instead of using the interface
  assert.ok(looksLikeUnexecutedToolCall('write_file(path="a.txt", content="hi")'));
});

test('looksLikeUnexecutedToolCall ignores ordinary final answers', () => {
  assert.equal(looksLikeUnexecutedToolCall('I updated the config and everything builds now.'), false);
  assert.equal(looksLikeUnexecutedToolCall('You can use `write_file` for that, or edit it by hand.'), false);
  assert.equal(looksLikeUnexecutedToolCall(''), false);
});

test('looksLikeUnexecutedToolCall ignores generated code that defines a tool-named function', () => {
  // A final answer containing code that merely defines a function sharing a
  // tool's name must not be mistaken for a tool call the model failed to emit.
  assert.equal(looksLikeUnexecutedToolCall('Here is a helper:\n\ndef grep(pattern, text):\n    return []'), false);
  assert.equal(looksLikeUnexecutedToolCall('function bash(cmd) {\n  return run(cmd);\n}'), false);
  // But a genuinely narrated call is still detected.
  assert.ok(looksLikeUnexecutedToolCall('grep(pattern="TODO", path="src")'));
});

// --- Agent context management ---------------------------------------------------

function makeAgent(numCtx = 200): Agent {
  return new Agent({ ...DEFAULT_CONFIG, numCtx });
}

test('prune truncates old tool outputs but keeps the system prompt and recent turns', () => {
  const agent = makeAgent(100); // budget ≈ 300 chars
  const messages = agent.getMessages();
  messages[0].content = 'system prompt'; // shrink so the budget math is predictable
  messages.push({ role: 'user', content: 'read stuff' });
  messages.push({ role: 'assistant', content: 'reading' });
  messages.push({ role: 'tool', content: 'x'.repeat(5000), tool_name: 'read_file' } as Message);
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: `follow-up ${i}` });
    messages.push({ role: 'assistant', content: `answer ${i}` });
  }
  (agent as unknown as { prune: () => void }).prune();
  const after = agent.getMessages();
  assert.equal(after[0].role, 'system');
  const tool = after.find((m) => m.role === 'tool');
  if (tool) assert.ok(tool.content.length <= 700, `old tool output should be truncated, got ${tool.content.length}`);
  assert.ok(after.length >= 8, 'keeps a minimum conversation window');
});

test('prune drops whole turns without orphaning a tool result', () => {
  const agent = makeAgent(50); // budget ≈ 150 chars — forces a drop
  const messages = agent.getMessages();
  messages[0].content = 'sys';
  // Oldest turn: an assistant tool call plus its (large) tool result.
  messages.push({ role: 'user', content: 'do a thing' });
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
  } as Message);
  messages.push({ role: 'tool', content: 'y'.repeat(2000), tool_name: 'read_file' } as Message);
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'user', content: `q${i} ${'z'.repeat(40)}` });
    messages.push({ role: 'assistant', content: `a${i} ${'z'.repeat(40)}` });
  }
  (agent as unknown as { prune: () => void }).prune();
  const after = agent.getMessages();
  assert.equal(after[0].role, 'system');
  // The first message after the system prompt must never be an orphaned tool result.
  assert.notEqual(after[1].role, 'tool');
  // Every surviving tool result must still follow an assistant/tool message.
  for (let i = 0; i < after.length; i++) {
    if (after[i].role === 'tool') {
      assert.ok(i > 0 && (after[i - 1].role === 'assistant' || after[i - 1].role === 'tool'),
        `orphaned tool result at index ${i}`);
    }
  }
});

test('estimatedTokens survives messages with missing content', () => {
  const agent = makeAgent();
  agent.getMessages().push({ role: 'assistant' } as unknown as Message);
  assert.ok(Number.isFinite(agent.estimatedTokens()));
});
