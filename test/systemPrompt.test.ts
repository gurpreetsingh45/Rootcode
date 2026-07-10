import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/systemPrompt.js';

let dir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootcode-prompt-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('includes the working directory and a directory snapshot', () => {
  fs.writeFileSync(path.join(dir, 'main.py'), '');
  fs.mkdirSync(path.join(dir, 'src'));
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(fs.realpathSync(dir)));
  assert.ok(prompt.includes('main.py'));
  assert.ok(prompt.includes('src/'));
});

test('loads project instructions from ROOTCODE.md when present', () => {
  fs.writeFileSync(path.join(dir, 'ROOTCODE.md'), 'Always use tabs.');
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('Project instructions (from ROOTCODE.md)'));
  assert.ok(prompt.includes('Always use tabs.'));
});

test('prefers ROOTCODE.md over CLAUDE.md but falls back to it', () => {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude rules');
  assert.ok(buildSystemPrompt().includes('claude rules'));
  fs.writeFileSync(path.join(dir, 'ROOTCODE.md'), 'rootcode rules');
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('rootcode rules'));
  assert.ok(!prompt.includes('claude rules'));
});

test('mentions directory-creation behavior so models do not invent mkdir steps', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('parent directories automatically'));
});

test('notes when the cwd is not a git repository', () => {
  assert.ok(buildSystemPrompt().includes('Not a git repository.'));
});

test('fences the repository map and marks it as untrusted data', () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('untrusted data describing the repo'));
  assert.ok(prompt.includes('REPO-MAP'));
});
