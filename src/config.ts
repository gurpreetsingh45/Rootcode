import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Config {
  model: string;
  host: string;
  /** Context window size passed to Ollama (num_ctx). */
  numCtx: number;
  /** Sampling temperature. */
  temperature: number;
  /** Skip all permission prompts when true. */
  yolo: boolean;
}

export const DEFAULT_CONFIG: Config = {
  model: 'qwen2.5-coder:7b',
  host: 'http://127.0.0.1:11434',
  numCtx: 16384,
  temperature: 0.2,
  yolo: false,
};

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'rootcode');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(configPath = CONFIG_PATH): Config {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config, configPath = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // yolo is a per-session flag, never persisted
  const { yolo: _yolo, ...persisted } = config;
  fs.writeFileSync(configPath, JSON.stringify(persisted, null, 2) + '\n');
}
