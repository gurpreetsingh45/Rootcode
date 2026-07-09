import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message } from 'ollama';
import {
  formatAge,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  sessionTitle,
  type Session,
} from '../src/sessions.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-sessions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newSessionId(),
    cwd: '/project',
    model: 'qwen2.5-coder:7b',
    title: 'fix the tests',
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'done' },
    ] as Message[],
    ...overrides,
  };
}

test('save and load round-trips a session', () => {
  const session = makeSession();
  saveSession(session, dir);
  const loaded = loadSession(session.id, dir);
  assert.ok(loaded);
  assert.equal(loaded.id, session.id);
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.messages[1].content, 'fix the tests');
});

test('sessions with no user message are not persisted', () => {
  const session = makeSession({ messages: [{ role: 'system', content: 'sys' }] as Message[] });
  saveSession(session, dir);
  assert.equal(loadSession(session.id, dir), null);
});

test('loadSession returns null for unknown ids', () => {
  assert.equal(loadSession('nope', dir), null);
});

test('listSessions filters by cwd and sorts newest first', () => {
  const old = makeSession({ updatedAt: '2026-07-01T00:00:00Z', title: 'old task' });
  const recent = makeSession({ updatedAt: '2026-07-09T00:00:00Z', title: 'recent task' });
  const elsewhere = makeSession({ cwd: '/other', title: 'other project' });
  saveSession(old, dir);
  saveSession(recent, dir);
  saveSession(elsewhere, dir);

  const list = listSessions('/project', dir);
  assert.deepEqual(
    list.map((s) => s.title),
    ['recent task', 'old task'],
  );
  assert.equal(list[0].messageCount, 3);
});

test('latestSession returns the most recently updated session for the cwd', () => {
  saveSession(makeSession({ updatedAt: '2026-07-01T00:00:00Z', title: 'old' }), dir);
  const recent = makeSession({ updatedAt: '2026-07-09T00:00:00Z', title: 'new' });
  saveSession(recent, dir);
  assert.equal(latestSession('/project', dir)?.id, recent.id);
  assert.equal(latestSession('/nowhere', dir), null);
});

test('saving under the same id updates rather than duplicates', () => {
  const session = makeSession();
  saveSession(session, dir);
  session.messages.push({ role: 'user', content: 'more' } as Message);
  session.updatedAt = new Date().toISOString();
  saveSession(session, dir);
  assert.equal(listSessions('/project', dir).length, 1);
  assert.equal(loadSession(session.id, dir)?.messages.length, 4);
});

test('old sessions are pruned beyond the cap', () => {
  for (let i = 0; i < 55; i++) {
    saveSession(makeSession(), dir);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length <= 50, `expected <= 50 session files, found ${files.length}`);
});

test('loadSession returns null for corrupt JSON instead of throwing', () => {
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
  assert.equal(loadSession('bad', dir), null);
});

test('loadSession sanitizes malformed messages so the agent cannot crash on them', () => {
  const session = makeSession();
  saveSession(session, dir);
  // Simulate a hand-edited / partially written session file
  const p = path.join(dir, `${session.id}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.messages.push({ role: 'assistant' }); // no content
  raw.messages.push('garbage'); // not even an object
  raw.messages.push({ content: 'no role' });
  fs.writeFileSync(p, JSON.stringify(raw));

  const loaded = loadSession(session.id, dir);
  assert.ok(loaded);
  for (const m of loaded.messages) {
    assert.equal(typeof m.role, 'string');
    assert.equal(typeof m.content, 'string');
  }
});

test('listSessions skips corrupt files but keeps good ones', () => {
  saveSession(makeSession(), dir);
  fs.writeFileSync(path.join(dir, 'zz-corrupt.json'), '{{{{');
  assert.equal(listSessions('/project', dir).length, 1);
});

test('formatAge buckets minutes, hours, and days', () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  assert.equal(formatAge(at(10_000)), 'just now');
  assert.equal(formatAge(at(5 * 60_000)), '5m ago');
  assert.equal(formatAge(at(3 * 3_600_000)), '3h ago');
  assert.equal(formatAge(at(48 * 3_600_000)), '2d ago');
  assert.equal(formatAge('not-a-date'), '');
  assert.equal(formatAge(new Date(Date.now() + 60_000).toISOString()), ''); // future
});

test('sessionTitle uses the first user message, collapsed and truncated', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '  fix\n\nthe   tests  ' + 'x'.repeat(200) },
  ] as Message[];
  const title = sessionTitle(messages);
  assert.ok(title.startsWith('fix the tests'));
  assert.ok(title.length <= 80);
  assert.equal(sessionTitle([{ role: 'system', content: 'sys' }] as Message[]), '(empty session)');
});
