import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DiffLine, TodoItem } from '../tools.js';
import type { PermissionRequest, PermissionDecision } from '../agent.js';
import { renderMarkdown } from './markdown.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
      <Text color="magenta">{SPINNER_FRAMES[frame]}</Text> <Text dimColor>{label}</Text>
    </Text>
  );
}

export function DiffView({ lines, maxLines = 30 }: { lines: DiffLine[]; maxLines?: number }) {
  const shown = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => {
        if (l.kind === 'add')
          return (
            <Text key={i} color="green">
              {l.text}
            </Text>
          );
        if (l.kind === 'del')
          return (
            <Text key={i} color="red">
              {l.text}
            </Text>
          );
        if (l.kind === 'meta')
          return (
            <Text key={i} color="cyan" dimColor>
              {l.text}
            </Text>
          );
        return (
          <Text key={i} dimColor>
            {l.text}
          </Text>
        );
      })}
      {lines.length > maxLines && <Text dimColor>… {lines.length - maxLines} more lines</Text>}
    </Box>
  );
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {todos.map((t, i) => {
        if (t.status === 'completed')
          return (
            <Text key={i} dimColor strikethrough>
              {'  ✓ '}
              {t.content}
            </Text>
          );
        if (t.status === 'in_progress')
          return (
            <Text key={i} color="cyan">
              {'  ▶ '}
              {t.content}
            </Text>
          );
        return <Text key={i}>{'  ○ ' + t.content}</Text>;
      })}
    </Box>
  );
}

export function PermissionPrompt({
  request,
  onDecision,
}: {
  request: PermissionRequest;
  onDecision: (d: PermissionDecision) => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || key.return) onDecision('allow');
    else if (input === 'a') onDecision('always');
    else if (input === 'n' || key.escape) onDecision('deny');
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        <Text color="yellow" bold>
          ⚠ permission
        </Text>
        <Text> rootcode wants to run: </Text>
        <Text bold>{request.title}</Text>
      </Text>
      {request.preview.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <DiffView lines={request.preview} maxLines={20} />
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          <Text color="green" bold>
            y
          </Text>
          <Text dimColor>/enter allow once · </Text>
          <Text color="cyan" bold>
            a
          </Text>
          <Text dimColor> always allow {request.toolName} · </Text>
          <Text color="red" bold>
            n
          </Text>
          <Text dimColor>/esc deny</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Transcript items

export type Item =
  | { id: number; kind: 'banner'; model: string; host: string; version: string }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      title: string;
      output: string;
      isError: boolean;
      diffLines?: DiffLine[];
    }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'error'; text: string };

export function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'banner':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} marginBottom={1}>
          <Text>
            <Text color="magenta" bold>
              ✻ rootcode
            </Text>
            <Text dimColor> v{item.version} — local coding agent</Text>
          </Text>
          <Text dimColor>model {item.model} · {item.host}</Text>
          <Text dimColor>cwd {process.cwd()}</Text>
          <Text dimColor>/help for commands · esc interrupts · ctrl+c twice exits</Text>
        </Box>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan" bold>
              {'❯ '}
            </Text>
            <Text bold>{item.text}</Text>
          </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} paddingRight={2}>
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
    case 'tool': {
      const preview = item.output.split('\n').slice(0, 3).join('\n');
      const truncated = item.output.split('\n').length > 3;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={item.isError ? 'red' : 'green'}>{'⏺ '}</Text>
            <Text>{item.title}</Text>
          </Text>
          {item.diffLines && item.diffLines.length > 0 ? (
            <Box paddingLeft={2}>
              <DiffView lines={item.diffLines} />
            </Box>
          ) : (
            <Box paddingLeft={2}>
              <Text dimColor>
                {preview}
                {truncated ? ' …' : ''}
              </Text>
            </Box>
          )}
        </Box>
      );
    }
    case 'info':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text color="cyan">{item.text}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text color="red">✗ {item.text}</Text>
        </Box>
      );
  }
}
