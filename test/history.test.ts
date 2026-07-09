import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendInputHistory, loadInputHistory } from '../src/history.js';

let dir: string;
let historyPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rootcode-history-'));
  historyPath = path.join(dir, 'history.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history starts empty and appends in order', () => {
  assert.deepEqual(loadInputHistory(historyPath), []);
  appendInputHistory('first', historyPath);
  appendInputHistory('second', historyPath);
  assert.deepEqual(loadInputHistory(historyPath), ['first', 'second']);
});

test('re-entering a command moves it to the end instead of duplicating', () => {
  appendInputHistory('a', historyPath);
  appendInputHistory('b', historyPath);
  appendInputHistory('a', historyPath);
  assert.deepEqual(loadInputHistory(historyPath), ['b', 'a']);
});

test('history is capped at 200 entries, keeping the newest', () => {
  for (let i = 0; i < 210; i++) appendInputHistory(`cmd ${i}`, historyPath);
  const items = loadInputHistory(historyPath);
  assert.equal(items.length, 200);
  assert.equal(items.at(-1), 'cmd 209');
  assert.equal(items[0], 'cmd 10');
});

test('a corrupt history file is treated as empty, and non-strings are dropped', () => {
  fs.writeFileSync(historyPath, 'not json');
  assert.deepEqual(loadInputHistory(historyPath), []);
  fs.writeFileSync(historyPath, JSON.stringify(['ok', 42, null, 'also ok']));
  assert.deepEqual(loadInputHistory(historyPath), ['ok', 'also ok']);
});
