import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const HISTORY_PATH = path.join(CONFIG_DIR, 'history.json');
const MAX_HISTORY = 200;

export function loadInputHistory(historyPath = HISTORY_PATH): string[] {
  try {
    const items = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(items) ? items.filter((i) => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

export function appendInputHistory(entry: string, historyPath = HISTORY_PATH): void {
  const items = loadInputHistory(historyPath).filter((i) => i !== entry);
  items.push(entry);
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(items.slice(-MAX_HISTORY), null, 2));
  } catch {
    // history persistence is best-effort
  }
}
