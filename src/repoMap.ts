import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIRS } from './tools.js';

/**
 * A compact, deterministic orientation of the project, injected into the system
 * prompt so a (weak, local) model doesn't spend several tool-call turns just
 * rediscovering the repo's language, build commands, and layout.
 *
 * It is re-prefilled on every model call, so it is deliberately capped and
 * cached: built once per working directory, never regenerated mid-session.
 *
 * Everything here is derived from an untrusted working directory (a cloned repo,
 * a manifest, filenames), so names are sanitized before being embedded and the
 * whole block is fenced as untrusted content by systemPrompt.ts.
 */

const MAX_MAP_CHARS = 2200; // ~550 tokens — small on purpose (re-sent every turn)
const MAX_COUNT_DEPTH = 6; // guard against pathologically deep trees when counting
const MAX_NODE_VISITS = 5000; // total dirs/files visited per map build (breadth guard)
const MAX_FIELD_LEN = 60; // per-name cap before names are embedded in the prompt
const MAX_MANIFEST_BYTES = 512_000; // don't slurp a pathologically large manifest/Makefile

const cache = new Map<string, string>();

/** Clear the per-cwd cache. Only needed by tests that reuse a directory. */
export function clearRepoMapCache(): void {
  cache.clear();
}

/**
 * Make a filesystem- or manifest-derived string safe to embed in the system
 * prompt: collapse control characters (Linux filenames and JSON string fields
 * can contain newlines) to spaces so untrusted repo content can't forge new
 * prompt lines, then cap length. The block is additionally fenced by the caller.
 */
function sanitizeField(s: string, max = MAX_FIELD_LEN): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? ' ' : ch; // control chars -> space
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max) + '\u2026' : out;
}

interface ProjectInfo {
  type: string;
  name?: string;
  /** [label, command] pairs, e.g. ["test", "npm run test"]. */
  commands: Array<[string, string]>;
}

/** Read and parse a JSON file, skipping ones too large to be a sane manifest. */
function readJson(p: string): Record<string, unknown> | null {
  try {
    if (fs.statSync(p).size > MAX_MANIFEST_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Detect the project's language/toolchain and its build/test/run commands. */
function detectProject(cwd: string): ProjectInfo {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));

  const pkg = readJson(path.join(cwd, 'package.json'));
  if (pkg) {
    const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
    const commands: Array<[string, string]> = [];
    for (const key of ['build', 'test', 'lint', 'typecheck', 'dev', 'start']) {
      if (typeof scripts[key] === 'string') commands.push([key, `npm run ${key}`]);
    }
    return {
      type: has('tsconfig.json') ? 'Node.js/TypeScript' : 'Node.js',
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      commands,
    };
  }

  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) {
    const commands: Array<[string, string]> = [];
    if (has('pytest.ini') || has('tests') || has('test') || has('pyproject.toml')) commands.push(['test', 'pytest']);
    return { type: 'Python', commands: withMakeTargets(cwd, commands) };
  }
  if (has('go.mod')) {
    return { type: 'Go', commands: [['build', 'go build ./...'], ['test', 'go test ./...']] };
  }
  if (has('Cargo.toml')) {
    return { type: 'Rust', commands: [['build', 'cargo build'], ['test', 'cargo test']] };
  }
  if (has('pom.xml')) {
    return { type: 'Java (Maven)', commands: [['build', 'mvn package'], ['test', 'mvn test']] };
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    return { type: 'Java/Kotlin (Gradle)', commands: [['build', 'gradle build'], ['test', 'gradle test']] };
  }
  if (has('Gemfile')) return { type: 'Ruby', commands: withMakeTargets(cwd, []) };
  if (has('composer.json')) return { type: 'PHP', commands: withMakeTargets(cwd, []) };

  return { type: 'unknown', commands: withMakeTargets(cwd, []) };
}

/** If commands are missing, surface a few well-known Makefile targets. */
function withMakeTargets(cwd: string, commands: Array<[string, string]>): Array<[string, string]> {
  if (commands.length > 0) return commands;
  const makefile = path.join(cwd, 'Makefile');
  let text: string;
  try {
    if (fs.statSync(makefile).size > MAX_MANIFEST_BYTES) return commands;
    text = fs.readFileSync(makefile, 'utf8');
  } catch {
    return commands;
  }
  const targets = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:/);
    if (m) targets.add(m[1]);
  }
  const out: Array<[string, string]> = [];
  for (const t of ['build', 'test', 'lint', 'run']) {
    if (targets.has(t)) out.push([t, `make ${t}`]);
  }
  return out;
}

/** A shared budget so a single map build can't enumerate an unbounded tree. */
interface Budget {
  left: number;
}

/**
 * Count files under `dir`, skipping build/vendor directories. Bounded in both
 * depth (MAX_COUNT_DEPTH) and total nodes visited (the shared `budget`) so a
 * high-fan-out directory can't hang the single-threaded UI at session start.
 */
function countFiles(dir: string, budget: Budget, depth = 0): number {
  if (depth > MAX_COUNT_DEPTH || budget.left <= 0) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (budget.left <= 0) break;
    budget.left--;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) n += countFiles(path.join(dir, e.name), budget, depth + 1);
    } else {
      n++;
    }
  }
  return n;
}

/** A two-level directory outline with per-directory file counts. */
function buildLayout(cwd: string, budget: Budget): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return '(unreadable)';
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  const lines: string[] = [];
  for (const d of dirs.slice(0, 20)) {
    const full = path.join(cwd, d.name);
    lines.push(`  ${sanitizeField(d.name)}/  (${countFiles(full, budget)} files)`);
    let sub: fs.Dirent[] = [];
    try {
      sub = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      /* ignore */
    }
    const subDirs = sub
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const s of subDirs.slice(0, 8)) {
      lines.push(`    ${sanitizeField(d.name)}/${sanitizeField(s.name)}/  (${countFiles(path.join(full, s.name), budget)} files)`);
    }
  }
  if (files.length) {
    lines.push(`  files: ${files.slice(0, 15).map((f) => sanitizeField(f)).join(', ')}${files.length > 15 ? ', …' : ''}`);
  }
  return lines.join('\n') || '(empty directory)';
}

/**
 * Build (and cache) the repository map for `cwd`. Cached per (directory, cap):
 * the map is a session-stable orientation, not a live view, so it is computed
 * once. `maxChars` lets the caller shrink the map on small context windows.
 */
export function buildRepoMap(cwd = process.cwd(), maxChars = MAX_MAP_CHARS): string {
  const key = `${cwd}::${maxChars}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const info = detectProject(cwd);
  const parts: string[] = [];
  const name = info.name ? sanitizeField(info.name) : '';
  parts.push(`Type: ${name ? `${info.type} · package "${name}"` : info.type}`);
  if (info.commands.length) {
    parts.push('Commands: ' + info.commands.map(([k, v]) => `${k}=\`${v}\``).join(' · '));
  }
  parts.push('Layout:');
  parts.push(buildLayout(cwd, { left: MAX_NODE_VISITS }));

  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n… [map truncated]';
  cache.set(key, out);
  return out;
}
