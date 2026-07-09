import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import path from 'node:path';
import { Agent, InterruptedError, type PermissionDecision, type PermissionRequest } from '../agent.js';
import { saveConfig } from '../config.js';
import { formatAge, listSessions, loadSession } from '../sessions.js';
import { appendInputHistory, loadInputHistory } from '../history.js';
import { TOOLS, clearTodos, getTodos, type DiffLine, type TodoItem } from '../tools.js';
import { Input, type SlashCommand } from './Input.js';
import { ItemView, PermissionPrompt, Spinner, TodoPanel, type Item } from './components.js';
import { renderMarkdown } from './markdown.js';

const VERSION = '0.1.0';

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'show help' },
  { name: '/model', description: 'show or switch model (/model <name>)' },
  { name: '/models', description: 'list installed Ollama models' },
  { name: '/tools', description: 'list available tools' },
  { name: '/clear', description: 'clear conversation and start fresh' },
  { name: '/resume', description: 'list past sessions, /resume <n> to restore one' },
  { name: '/compact', description: 'summarize conversation to free context' },
  { name: '/yolo', description: 'toggle auto-approval of all tools' },
  { name: '/exit', description: 'quit rootcode' },
];

const HELP_TEXT = `commands:
  /model <name>   switch model (persisted) · /models lists installed ones
  /tools          list tools    /clear    reset conversation
  /resume         list past sessions in this directory, /resume <n> restores one
  /compact        summarize history to free context
  /yolo           toggle skipping permission prompts
  /exit           quit (or ctrl+c twice)
keys:
  esc             interrupt the agent while it works
  up/down         input history      tab   complete slash command
  \\ + enter       insert a newline`;

interface PendingPermission {
  request: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

/** Omit distributed over the Item union, so each variant keeps its own shape. */
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, 'id'> : never) : never;

const REPLAY_LIMIT = 30;

/** Turn a restored conversation into transcript items (user/assistant turns only). */
function replayItems(messages: Array<{ role: string; content: string }>): NewItem[] {
  const out: NewItem[] = [];
  for (const m of messages) {
    // Skip synthetic user messages ("[Interrupted by user]", compact summaries)
    if (m.role === 'user' && m.content.trim() && !m.content.startsWith('[')) {
      out.push({ kind: 'user', text: m.content });
    } else if (m.role === 'assistant' && m.content.trim()) {
      out.push({ kind: 'assistant', text: m.content });
    }
  }
  return out.slice(-REPLAY_LIMIT);
}

export function App({
  agent,
  initialPrompt,
  resumeNotice,
}: {
  agent: Agent;
  initialPrompt?: string;
  resumeNotice?: string;
}) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>(() => {
    const initial: Item[] = [
      { id: 0, kind: 'banner', model: agent.config.model, host: agent.config.host, version: VERSION },
    ];
    if (resumeNotice) {
      replayItems(agent.getMessages()).forEach((it, i) => initial.push({ ...it, id: -100 - i } as Item));
      initial.push({ id: -1, kind: 'info', text: resumeNotice });
    }
    return initial;
  });
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [exitHint, setExitHint] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>(() => loadInputHistory());
  const nextId = useRef(1);
  const ctrlCArmed = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSent = useRef(false);
  const resumeChoices = useRef<string[]>([]);

  const addItem = useCallback((item: NewItem) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as Item]);
  }, []);

  const callbacks = useMemo(
    () => ({
      onText: (text: string) => setStreamText(text),
      onTextDone: (text: string) => {
        setStreamText('');
        addItem({ kind: 'assistant', text });
      },
      onToolStart: (_id: number, _name: string, title: string) => setActiveTool(title),
      onToolEnd: (_id: number, name: string, title: string, output: string, isError: boolean, diffLines?: DiffLine[]) => {
        setActiveTool(null);
        addItem({ kind: 'tool', name, title, output, isError, diffLines });
        if (name === 'todo_write') setTodos([...getTodos()]);
      },
      onPermission: (request: PermissionRequest) =>
        new Promise<PermissionDecision>((resolve) => setPermission({ request, resolve })),
      onStatus: (s: string) => setStatus(s),
    }),
    [addItem],
  );

  const runAgent = useCallback(
    async (prompt: string) => {
      setBusy(true);
      try {
        await agent.run(prompt, callbacks);
      } catch (err) {
        setStreamText('');
        if (err instanceof InterruptedError) addItem({ kind: 'info', text: 'interrupted' });
        else addItem({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
        setActiveTool(null);
        setStatus('');
      }
    },
    [agent, callbacks, addItem],
  );

  const handleSlash = useCallback(
    async (input: string): Promise<boolean> => {
      const [cmd, ...rest] = input.split(/\s+/);
      const arg = rest.join(' ').trim();
      switch (cmd) {
        case '/help':
          addItem({ kind: 'info', text: HELP_TEXT });
          return true;
        case '/exit':
        case '/quit':
          exit();
          return true;
        case '/clear':
          agent.reset();
          clearTodos();
          setTodos([]);
          addItem({ kind: 'info', text: 'conversation cleared' });
          return true;
        case '/tools':
          addItem({
            kind: 'info',
            text: Object.values(TOOLS)
              .map((t) => `${(t.definition.function.name ?? '').padEnd(12)} ${t.definition.function.description?.split('.')[0]}`)
              .join('\n'),
          });
          return true;
        case '/yolo':
          agent.config.yolo = !agent.config.yolo;
          addItem({
            kind: 'info',
            text: agent.config.yolo ? 'yolo ON — all tool calls auto-approved' : 'yolo off — permission prompts restored',
          });
          return true;
        case '/models':
        case '/model': {
          if (cmd === '/model' && arg) {
            agent.config.model = arg;
            saveConfig(agent.config);
            addItem({ kind: 'info', text: `model set to ${arg}` });
            return true;
          }
          try {
            const models = await agent.listModels();
            addItem({
              kind: 'info',
              text: `current: ${agent.config.model}\ninstalled:\n${models.map((m) => `  ${m}`).join('\n')}\n\nswitch with /model <name>`,
            });
          } catch (err) {
            addItem({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
          }
          return true;
        }
        case '/resume': {
          if (arg) {
            const id = /^\d+$/.test(arg) ? resumeChoices.current[Number(arg) - 1] : arg;
            const session = id ? loadSession(id) : null;
            if (!session) {
              addItem({ kind: 'error', text: `no such session — run /resume to list them` });
              return true;
            }
            agent.restoreSession(session);
            clearTodos();
            setTodos([]);
            for (const it of replayItems(session.messages)) addItem(it);
            addItem({
              kind: 'info',
              text: `resumed session from ${formatAge(session.updatedAt)}: "${session.title}" (${session.messages.length} messages)`,
            });
            return true;
          }
          const sessions = listSessions(process.cwd()).slice(0, 10);
          if (sessions.length === 0) {
            addItem({ kind: 'info', text: 'no saved sessions for this directory yet' });
            return true;
          }
          resumeChoices.current = sessions.map((s) => s.id);
          addItem({
            kind: 'info',
            text:
              sessions
                .map((s, i) => `${String(i + 1).padStart(2)}. ${formatAge(s.updatedAt).padEnd(12)} ${s.title.slice(0, 60)} (${s.messageCount} msgs)`)
                .join('\n') + '\n\nrestore one with /resume <n>',
          });
          return true;
        }
        case '/compact':
          setBusy(true);
          try {
            await agent.compact((s) => setStatus(s));
            addItem({ kind: 'info', text: 'conversation compacted' });
          } catch (err) {
            addItem({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
          } finally {
            setBusy(false);
            setStatus('');
          }
          return true;
        default:
          if (cmd.startsWith('/')) {
            addItem({ kind: 'error', text: `unknown command ${cmd} — try /help` });
            return true;
          }
          return false;
      }
    },
    [agent, addItem, exit],
  );

  const handleSubmit = useCallback(
    async (value: string) => {
      appendInputHistory(value);
      setInputHistory((prev) => [...prev.filter((h) => h !== value), value]);
      if (await handleSlash(value)) return;
      addItem({ kind: 'user', text: value });
      void runAgent(value);
    },
    [handleSlash, addItem, runAgent],
  );

  // Auto-submit an initial prompt passed on the command line
  if (initialPrompt && !initialSent.current) {
    initialSent.current = true;
    setTimeout(() => void handleSubmit(initialPrompt), 0);
  }

  useInput((input, key) => {
    if (key.escape && busy && !permission) {
      agent.abort();
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy && !permission) {
        agent.abort();
        return;
      }
      if (ctrlCArmed.current) {
        exit();
        return;
      }
      setExitHint(true);
      ctrlCArmed.current = setTimeout(() => {
        ctrlCArmed.current = null;
        setExitHint(false);
      }, 1500);
    }
  });

  const tokens = agent.estimatedTokens();
  const ctxPct = Math.min(99, Math.round((tokens / agent.config.numCtx) * 100));

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} />}</Static>

      {streamText.length > 0 && (
        <Box marginTop={1} paddingRight={2}>
          <Text>{renderMarkdown(streamText)}</Text>
        </Box>
      )}

      {busy && (
        <Box marginTop={1} paddingLeft={1}>
          <Spinner label={activeTool ?? (status || 'thinking')} />
          <Text dimColor> (esc to interrupt)</Text>
        </Box>
      )}

      <TodoPanel todos={todos} />

      <Box marginTop={1} flexDirection="column">
        {permission ? (
          <PermissionPrompt
            request={permission.request}
            onDecision={(d) => {
              permission.resolve(d);
              setPermission(null);
            }}
          />
        ) : (
          <Input active={!busy} history={inputHistory} slashCommands={SLASH_COMMANDS} onSubmit={handleSubmit} />
        )}
        <Box paddingX={1} justifyContent="space-between">
          <Text dimColor>
            {agent.config.model} · {path.basename(process.cwd())} · ~{tokens} tok ({ctxPct}% ctx)
            {agent.lastTokensPerSec > 0 ? ` · ${agent.lastTokensPerSec} tok/s` : ''}
            {agent.config.yolo ? ' · YOLO' : ''}
          </Text>
          <Text color={exitHint ? 'yellow' : undefined} dimColor={!exitHint}>
            {exitHint ? 'press ctrl+c again to exit' : '/help'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
