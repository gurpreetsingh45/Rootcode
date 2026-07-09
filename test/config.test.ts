import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-'));
  configPath = path.join(dir, 'nested', 'config.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig falls back to defaults when the file is missing', () => {
  assert.deepEqual(loadConfig(configPath), DEFAULT_CONFIG);
});

test('loadConfig falls back to defaults when the file is corrupt', () => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, '{ nope');
  assert.deepEqual(loadConfig(configPath), DEFAULT_CONFIG);
});

test('save/load round-trips settings and merges with defaults', () => {
  saveConfig({ ...DEFAULT_CONFIG, model: 'llama3.1:8b', numCtx: 32768 }, configPath);
  const loaded = loadConfig(configPath);
  assert.equal(loaded.model, 'llama3.1:8b');
  assert.equal(loaded.numCtx, 32768);
  assert.equal(loaded.host, DEFAULT_CONFIG.host);
});

test('yolo is never persisted to disk', () => {
  saveConfig({ ...DEFAULT_CONFIG, yolo: true }, configPath);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(!('yolo' in raw));
  assert.equal(loadConfig(configPath).yolo, false);
});

test('unknown keys in the file are tolerated', () => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ model: 'm', someFutureSetting: 42 }));
  assert.equal(loadConfig(configPath).model, 'm');
});
