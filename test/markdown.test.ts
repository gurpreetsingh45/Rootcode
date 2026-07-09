import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/ui/markdown.js';

/** Strip ANSI escape codes so assertions work with or without color support. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renders headers as their text without the # marks', () => {
  const out = plain(renderMarkdown('## Setup steps'));
  assert.ok(out.includes('Setup steps'));
  assert.ok(!out.includes('##'));
});

test('renders fenced code blocks inside a box with the language label', () => {
  const out = plain(renderMarkdown('before\n```python\nprint("hi")\n```\nafter'));
  assert.ok(out.includes('┌─ python'));
  assert.ok(out.includes('│ print("hi")'));
  assert.ok(out.includes('└─'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('renders an unclosed fence (mid-stream) without losing the code', () => {
  const out = plain(renderMarkdown('```js\nconst x = 1;'));
  assert.ok(out.includes('│ const x = 1;'));
});

test('does not treat markdown inside code blocks as markdown', () => {
  const out = plain(renderMarkdown('```\n# not a header\n- not a bullet\n```'));
  assert.ok(out.includes('│ # not a header'));
  assert.ok(out.includes('│ - not a bullet'));
});

test('renders bullets, blockquotes, and horizontal rules', () => {
  const out = plain(renderMarkdown('- item one\n> quoted\n---'));
  assert.ok(out.includes('• item one'));
  assert.ok(out.includes('▌ quoted'));
  assert.ok(out.includes('─'.repeat(10)));
});

test('strips inline markers for code, bold, and links', () => {
  const out = plain(renderMarkdown('use `npm test` to run **all** tests, see [docs](https://x.dev)'));
  assert.ok(out.includes('npm test'));
  assert.ok(!out.includes('`'));
  assert.ok(out.includes('all'));
  assert.ok(!out.includes('**'));
  assert.ok(out.includes('docs https://x.dev'));
});

test('is stable on empty and whitespace-only input', () => {
  assert.equal(plain(renderMarkdown('')), '');
  assert.equal(plain(renderMarkdown('\n\n')), '\n\n');
});
