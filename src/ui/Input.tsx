import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SlashCommand {
  name: string;
  description: string;
}

interface Props {
  active: boolean;
  history: string[];
  slashCommands: SlashCommand[];
  onSubmit: (value: string) => void;
}

export function Input({ active, history, slashCommands, onSubmit }: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1); // -1 = editing a fresh draft
  const [draft, setDraft] = useState('');

  const insert = (text: string) => {
    setValue(value.slice(0, cursor) + text + value.slice(cursor));
    setCursor(cursor + text.length);
  };

  const setAll = (v: string) => {
    setValue(v);
    setCursor(v.length);
  };

  const slashMatches =
    value.startsWith('/') && !value.includes(' ')
      ? slashCommands.filter((c) => c.name.startsWith(value))
      : [];

  useInput(
    (input, key) => {
      if (key.return) {
        if (value.endsWith('\\')) {
          // backslash + enter = newline
          setValue(value.slice(0, -1) + '\n');
          setCursor(value.length);
          return;
        }
        const trimmed = value.trim();
        if (!trimmed) return;
        setAll('');
        setHistIdx(-1);
        setDraft('');
        onSubmit(trimmed);
        return;
      }
      if (key.tab && slashMatches.length > 0) {
        setAll(slashMatches[0].name + ' ');
        return;
      }
      if (key.upArrow) {
        if (history.length === 0) return;
        const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
        if (histIdx === -1) setDraft(value);
        setHistIdx(next);
        setAll(history[next] ?? '');
        return;
      }
      if (key.downArrow) {
        if (histIdx === -1) return;
        const next = histIdx + 1;
        if (next >= history.length) {
          setHistIdx(-1);
          setAll(draft);
        } else {
          setHistIdx(next);
          setAll(history[next] ?? '');
        }
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
        return;
      }
      if (key.ctrl) {
        if (input === 'a') setCursor(0);
        else if (input === 'e') setCursor(value.length);
        else if (input === 'u') {
          setValue(value.slice(cursor));
          setCursor(0);
        } else if (input === 'k') {
          setValue(value.slice(0, cursor));
        } else if (input === 'w') {
          const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
          setValue(before + value.slice(cursor));
          setCursor(before.length);
        }
        return;
      }
      if (key.meta || key.escape) return;
      if (input) insert(input);
    },
    { isActive: active },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={active ? 'cyan' : 'gray'} paddingX={1}>
        <Text color="cyan">{'❯ '}</Text>
        {value.length === 0 ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{'  ask anything · "/" for commands · "\\" + enter for newline'}</Text>
          </Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{at === '\n' ? ' ' : at}</Text>
            {at === '\n' ? '\n' : ''}
            {after}
          </Text>
        )}
      </Box>
      {slashMatches.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashMatches.slice(0, 6).map((c, i) => (
            <Text key={c.name}>
              <Text color="cyan" bold={i === 0}>
                {c.name.padEnd(12)}
              </Text>
              <Text dimColor>{c.description}</Text>
              {i === 0 ? <Text dimColor> (tab to complete)</Text> : null}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
