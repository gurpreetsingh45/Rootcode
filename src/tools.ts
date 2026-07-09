import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import type { Tool } from 'ollama';
import * as Diff from 'diff';

export interface ToolResult {
  /** Text sent back to the model. */
  output: string;
  /** True if the tool failed. */
  isError?: boolean;
  /** Optional colorized diff lines for UI display. */
  diffLines?: DiffLine[];
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
}

export interface ToolSpec {
  definition: Tool;
  /** One-line summary of a call, shown in the UI. */
  title: (args: Record<string, unknown>) => string;
  /** Whether this call needs user approval before running. */
  needsPermission: (args: Record<string, unknown>) => boolean;
  /** Preview shown in the permission prompt (e.g. a diff or command). */
  preview?: (args: Record<string, unknown>) => DiffLine[];
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const MAX_OUTPUT_CHARS = 12_000;
const MAX_READ_LINES = 1500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next', 'target', 'vendor']);

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... [truncated, ${text.length - limit} more characters]`;
}

function resolvePath(p: unknown): string {
  const raw = typeof p === 'string' && p.length > 0 ? p : '.';
  return path.resolve(process.cwd(), raw);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`missing required string parameter "${key}"`);
  return v;
}

export function computeDiffLines(oldText: string, newText: string, filePath: string): DiffLine[] {
  const patch = Diff.structuredPatch(filePath, filePath, oldText, newText, '', '', { context: 3 });
  const lines: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    lines.push({ kind: 'meta', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    for (const line of hunk.lines) {
      if (line.startsWith('+')) lines.push({ kind: 'add', text: line });
      else if (line.startsWith('-')) lines.push({ kind: 'del', text: line });
      else lines.push({ kind: 'ctx', text: line });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// read_file

const readFile: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from disk. Returns the content with line numbers. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (relative or absolute)' },
          offset: { type: 'number', description: '1-based line number to start reading from' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
        required: ['path'],
      },
    },
  },
  title: (a) => `Read ${a.path}`,
  needsPermission: () => false,
  run: async (args) => {
    const p = resolvePath(str(args, 'path'));
    const stat = fs.statSync(p);
    if (stat.isDirectory()) throw new Error(`${p} is a directory; use list_dir instead`);
    if (stat.size > 2_000_000) throw new Error(`file is too large (${stat.size} bytes)`);
    const content = fs.readFileSync(p, 'utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Number(args.limit) || MAX_READ_LINES, MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n');
    const remaining = lines.length - (offset - 1 + slice.length);
    const note = remaining > 0 ? `\n... [${remaining} more lines, use offset=${offset + slice.length} to continue]` : '';
    return { output: truncate(numbered) + note };
  },
};

// ---------------------------------------------------------------------------
// write_file

const writeFile: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating it (and parent directories) if needed, or overwriting it entirely. For small changes to existing files prefer edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  title: (a) => `Write ${a.path}`,
  needsPermission: () => true,
  preview: (args) => {
    const p = resolvePath(String(args.path ?? ''));
    const next = String(args.content ?? '');
    const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    return computeDiffLines(prev, next, String(args.path));
  },
  run: async (args) => {
    const raw = str(args, 'path');
    if (raw.endsWith('/') || raw.endsWith(path.sep)) {
      throw new Error(
        `"${raw}" is a directory path — write_file writes files. Parent directories are created automatically, so write the full file path directly (e.g. "${raw}myFile.py"). To create an empty directory, use bash: mkdir -p "${raw}"`,
      );
    }
    const p = resolvePath(raw);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      throw new Error(`${p} is an existing directory — give a file path instead`);
    }
    const content = str(args, 'content');
    const existed = fs.existsSync(p);
    const prev = existed ? fs.readFileSync(p, 'utf8') : '';
    const conflict = findFileAncestor(path.dirname(p));
    if (conflict) {
      throw new Error(
        `cannot create directory ${path.dirname(p)}: a file already exists at ${conflict}. Delete or rename that file first (e.g. bash: rm "${conflict}"), then retry.`,
      );
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    const lineCount = content.split('\n').length;
    return {
      output: `${existed ? 'Updated' : 'Created'} ${p} (${lineCount} lines)`,
      diffLines: computeDiffLines(prev, content, p),
    };
  },
};

/** Walk up from `dir` and return the first ancestor that exists but is a file, if any. */
function findFileAncestor(dir: string): string | null {
  let cur = dir;
  while (true) {
    if (fs.existsSync(cur)) {
      return fs.statSync(cur).isDirectory() ? null : cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// edit_file

const editFile: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. old_string must match the file content exactly (including whitespace) and must be unique unless replace_all is true. Read the file first to get exact text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          old_string: { type: 'string', description: 'Exact text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  title: (a) => `Edit ${a.path}`,
  needsPermission: () => true,
  preview: (args) => {
    try {
      const p = resolvePath(String(args.path ?? ''));
      const content = fs.readFileSync(p, 'utf8');
      const next = applyEdit(content, String(args.old_string ?? ''), String(args.new_string ?? ''), Boolean(args.replace_all));
      return computeDiffLines(content, next, String(args.path));
    } catch (err) {
      return [{ kind: 'meta', text: `(preview unavailable: ${(err as Error).message})` }];
    }
  },
  run: async (args) => {
    const p = resolvePath(str(args, 'path'));
    const oldString = str(args, 'old_string');
    const newString = str(args, 'new_string');
    const content = fs.readFileSync(p, 'utf8');
    const next = applyEdit(content, oldString, newString, Boolean(args.replace_all));
    fs.writeFileSync(p, next);
    return {
      output: `Edited ${p}`,
      diffLines: computeDiffLines(content, next, p),
    };
  },
};

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString === '') throw new Error('old_string must not be empty');
  if (oldString === newString) throw new Error('old_string and new_string are identical');
  const count = content.split(oldString).length - 1;
  if (count === 0) throw new Error('old_string not found in file — read the file and match the exact text');
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string appears ${count} times — make it unique by adding surrounding lines, or set replace_all=true`);
  }
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
}

// ---------------------------------------------------------------------------
// list_dir

const listDir: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path. Directories end with "/".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: current directory)' },
        },
        required: [],
      },
    },
  },
  title: (a) => `List ${a.path ?? '.'}`,
  needsPermission: () => false,
  run: async (args) => {
    const p = resolvePath(args.path);
    const entries = fs.readdirSync(p, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const size = fs.statSync(path.join(p, e.name)).size;
        return `${e.name} (${formatSize(size)})`;
      } catch {
        return e.name;
      }
    });
    return { output: truncate(lines.join('\n') || '(empty directory)') };
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// glob

const globTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern, e.g. "**/*.ts" or "src/**/*.test.js". Ignores node_modules, .git, dist, and other build directories.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
        },
        required: ['pattern'],
      },
    },
  },
  title: (a) => `Glob ${a.pattern}`,
  needsPermission: () => false,
  run: async (args) => {
    const pattern = str(args, 'pattern');
    const cwd = resolvePath(args.path);
    const matches = fs.globSync(pattern, {
      cwd,
      exclude: (file: string) => SKIP_DIRS.has(path.basename(file)),
    });
    matches.sort();
    const shown = matches.slice(0, 200);
    const note = matches.length > shown.length ? `\n... [${matches.length - shown.length} more matches]` : '';
    return { output: (shown.join('\n') || 'No files matched.') + note };
  },
};

// ---------------------------------------------------------------------------
// grep

const grepTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents for a regular expression. Returns matching lines as "file:line: text". Use include to filter by file glob, e.g. "*.ts".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for' },
          path: { type: 'string', description: 'Directory or file to search (default: current directory)' },
          include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.py"' },
        },
        required: ['pattern'],
      },
    },
  },
  title: (a) => `Grep /${a.pattern}/${a.include ? ` in ${a.include}` : ''}`,
  needsPermission: () => false,
  run: async (args) => {
    const pattern = str(args, 'pattern');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error(`invalid regular expression: ${pattern}`);
    }
    const root = resolvePath(args.path);
    const include = typeof args.include === 'string' ? args.include : undefined;
    const files = collectFiles(root, include);
    const results: string[] = [];
    outer: for (const file of files) {
      let content: string;
      try {
        if (fs.statSync(file).size > 1_000_000) continue;
        content = fs.readFileSync(file, 'utf8');
        if (content.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const rel = path.relative(process.cwd(), file) || file;
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= 100) {
            results.push('... [more matches truncated]');
            break outer;
          }
        }
      }
    }
    return { output: truncate(results.join('\n') || 'No matches found.') };
  },
};

function collectFiles(root: string, include?: string): string[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const pattern = include ? `**/${include}` : '**/*';
  return fs
    .globSync(pattern, {
      cwd: root,
      exclude: (file: string) => SKIP_DIRS.has(path.basename(file)),
    })
    .map((m) => path.join(root, m))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    })
    .slice(0, 5000);
}

// ---------------------------------------------------------------------------
// bash

// Anything that can chain another command, redirect output, or substitute a
// subcommand disqualifies a command from running prompt-free.
const SHELL_METACHARS = /[;&|<>`\n\r]|\$\(/;

// Commands that are read-only no matter what arguments they get (metacharacters
// are already excluded above, so e.g. `echo` cannot redirect).
const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'file', 'du', 'df',
  'stat', 'uname', 'whoami', 'id', 'hostname', 'uptime', 'ps', 'grep', 'rg', 'tree',
]);

// Git subcommands that only inspect the repository regardless of flags.
const READONLY_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'reflog']);

/**
 * True if a shell command is read-only and may run without user approval.
 * Must never match a command that can modify files, git state, or the system.
 */
export function isSafeCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || SHELL_METACHARS.test(cmd)) return false;
  const [head, ...args] = cmd.split(/\s+/);

  if (READONLY_COMMANDS.has(head)) return true;
  // `env CMD` / `date -s` run or mutate things; bare invocations only print
  if (head === 'env') return args.length === 0;
  if (head === 'date') return !args.some((a) => a === '-s' || a.startsWith('--set'));
  // find is read-only unless told to delete or execute
  if (head === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(a));
  if (head === 'git') {
    const [sub, ...rest] = args;
    if (READONLY_GIT_SUBCOMMANDS.has(sub)) return true;
    // listing forms only — a non-flag argument would create/delete things
    if (sub === 'branch' || sub === 'remote' || sub === 'tag') {
      return rest.every((a) => ['-v', '-vv', '-a', '-l', '--list'].includes(a));
    }
    return false;
  }
  if (head === 'node' || head === 'python' || head === 'python3') {
    return args.length === 1 && ['--version', '-v', '-V'].includes(args[0]);
  }
  if (head === 'npm') return ['ls', 'view', 'ping', '--version', '-v'].includes(args[0]);
  return false;
}

const bashTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command and return its stdout and stderr. Use for running builds, tests, git commands, installing packages, etc. Working directory is the project root.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 60, max 300)' },
        },
        required: ['command'],
      },
    },
  },
  title: (a) => `$ ${String(a.command ?? '').slice(0, 120)}`,
  needsPermission: (args) => !isSafeCommand(String(args.command ?? '')),
  preview: (args) => [{ kind: 'ctx', text: ` ${String(args.command ?? '')}` }],
  run: async (args) => {
    const command = str(args, 'command');
    const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 300) * 1000;
    return new Promise<ToolResult>((resolve) => {
      exec(
        command,
        { cwd: process.cwd(), timeout, maxBuffer: 5_000_000, env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } },
        (error, stdout, stderr) => {
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n' : '') + stderr;
          if (error && error.killed) {
            output += `\n[command timed out after ${timeout / 1000}s]`;
          } else if (error && typeof error.code === 'number' && error.code !== 0) {
            output += `\n[exit code ${error.code}]`;
          }
          resolve({ output: truncate(output.trim() || '(no output)'), isError: Boolean(error) });
        },
      );
    });
  },
};

// ---------------------------------------------------------------------------
// todo_write

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

let currentTodos: TodoItem[] = [];
export const getTodos = (): TodoItem[] => currentTodos;
export const clearTodos = (): void => {
  currentTodos = [];
};

const todoWrite: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Replace your task list. Use this to plan multi-step work and track progress: mark the current task in_progress and finished tasks completed.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full task list',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Task description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  title: (a) => {
    const todos = Array.isArray(a.todos) ? (a.todos as TodoItem[]) : [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return `Update todos (${done}/${todos.length} done)`;
  },
  needsPermission: () => false,
  run: async (args) => {
    if (!Array.isArray(args.todos)) throw new Error('todos must be an array');
    currentTodos = (args.todos as Array<Record<string, unknown>>).map((t) => ({
      content: String(t.content ?? ''),
      status: (['pending', 'in_progress', 'completed'].includes(String(t.status)) ? t.status : 'pending') as TodoItem['status'],
    }));
    return { output: 'Todo list updated.' };
  },
};

// ---------------------------------------------------------------------------
// fetch_url

const fetchUrl: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL over HTTP(S) and return the response body as text (HTML tags stripped).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  title: (a) => `Fetch ${a.url}`,
  needsPermission: () => true,
  run: async (args) => {
    const url = str(args, 'url');
    if (!/^https?:\/\//.test(url)) throw new Error('only http(s) URLs are supported');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'vibe-agent/0.1' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (contentType.includes('html')) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n');
    }
    return { output: `HTTP ${res.status}\n${truncate(body.trim())}` };
  },
};

// ---------------------------------------------------------------------------

export const TOOLS: Record<string, ToolSpec> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_dir: listDir,
  glob: globTool,
  grep: grepTool,
  bash: bashTool,
  todo_write: todoWrite,
  fetch_url: fetchUrl,
};

export const TOOL_DEFINITIONS: Tool[] = Object.values(TOOLS).map((t) => t.definition);
