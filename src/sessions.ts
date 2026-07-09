import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Message } from 'ollama';

export interface Session {
  id: string;
  cwd: string;
  model: string;
  /** First user message, truncated — shown when listing sessions. */
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

const DEFAULT_DIR = path.join(os.homedir(), '.local', 'share', 'rootcode', 'sessions');
const MAX_SESSIONS = 50;

export function newSessionId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = (first?.content ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 80) || '(empty session)';
}

/** Persist a session to disk. Best-effort: failures never break the agent. */
export function saveSession(session: Session, dir = DEFAULT_DIR): void {
  // Don't persist sessions with no actual conversation
  if (!session.messages.some((m) => m.role === 'user')) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
    pruneSessions(dir);
  } catch {
    /* best-effort */
  }
}

export function loadSession(id: string, dir = DEFAULT_DIR): Session | null {
  try {
    const raw = fs.readFileSync(path.join(dir, `${id}.json`), 'utf8');
    const s = JSON.parse(raw);
    if (typeof s.id === 'string' && Array.isArray(s.messages)) {
      // Sanitize: a hand-edited or truncated file must not crash the agent later
      s.messages = s.messages
        .filter((m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null && typeof (m as { role?: unknown }).role === 'string')
        .map((m: Record<string, unknown>) => ({ ...m, content: typeof m.content === 'string' ? m.content : '' }));
      return s as Session;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** List sessions recorded for a working directory, newest first. */
export function listSessions(cwd: string, dir = DEFAULT_DIR): SessionSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions: Array<SessionSummary & { updatedAt: string }> = [];
  for (const file of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (s.cwd !== cwd || !Array.isArray(s.messages)) continue;
      sessions.push({
        id: String(s.id),
        title: String(s.title ?? ''),
        updatedAt: String(s.updatedAt ?? ''),
        messageCount: s.messages.length,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

/** The most recent session for a working directory, or null. */
export function latestSession(cwd: string, dir = DEFAULT_DIR): Session | null {
  const [latest] = listSessions(cwd, dir);
  return latest ? loadSession(latest.id, dir) : null;
}

/** Keep only the newest MAX_SESSIONS session files. */
function pruneSessions(dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { p } of files.slice(MAX_SESSIONS)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
