import chalk from 'chalk';
import { highlight } from 'cli-highlight';

function renderCodeBlock(code: string, lang: string): string {
  let colored = code;
  try {
    colored = highlight(code, { language: lang || undefined, ignoreIllegals: true });
  } catch {
    /* unknown language — leave plain */
  }
  const header = chalk.dim(lang ? `  ┌─ ${lang}` : '  ┌─');
  const body = colored
    .split('\n')
    .map((l) => chalk.dim('  │ ') + l)
    .join('\n');
  return `${header}\n${body}\n${chalk.dim('  └─')}`;
}

function renderInline(line: string): string {
  // headers
  const header = line.match(/^(#{1,6})\s+(.*)$/);
  if (header) return chalk.bold.cyan(header[2]);
  // horizontal rule
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return chalk.dim('─'.repeat(40));
  // blockquote
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) return chalk.dim('▌ ' + quote[1]);

  let out = line;
  // bullets
  out = out.replace(/^(\s*)[-*]\s+/, (_, indent: string) => `${indent}${chalk.dim('•')} `);
  // inline code
  out = out.replace(/`([^`]+)`/g, (_, code: string) => chalk.cyan(code));
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, text: string) => chalk.bold(text));
  // links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => `${text} ${chalk.blue.underline(url)}`);
  return out;
}

/** Convert markdown to an ANSI-styled string for terminal display. */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let inCode = false;
  let lang = '';
  let buffer: string[] = [];

  for (const line of lines) {
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        lang = fence[1] ?? '';
        buffer = [];
      } else {
        out.push(renderCodeBlock(buffer.join('\n'), lang));
        inCode = false;
      }
      continue;
    }
    if (inCode) buffer.push(line);
    else out.push(renderInline(line));
  }
  // unclosed fence (happens mid-stream)
  if (inCode) out.push(renderCodeBlock(buffer.join('\n'), lang));
  return out.join('\n');
}
