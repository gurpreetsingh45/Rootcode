import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { Agent, InterruptedError, type AgentCallbacks } from './agent.js';
import { loadConfig } from './config.js';
import { latestSession, formatAge } from './sessions.js';
import { App } from './ui/App.js';

const USAGE = `rootcode — local CLI coding agent powered by Ollama

usage:
  rootcode                       start interactive session
  rootcode "fix the tests"       start interactive session with an initial prompt
  rootcode -p "list the files"   headless mode: run one prompt, print, exit

options:
  -m, --model <name>   Ollama model to use (default from ~/.config/rootcode/config.json)
  -p, --print <text>   run a single prompt non-interactively and exit
  -c, --continue       resume the most recent session in this directory
      --host <url>     Ollama host (default http://127.0.0.1:11434)
      --ctx <n>        context window size (default 16384)
      --yolo           skip all permission prompts (required for writes in -p mode)
  -h, --help           show this help
  -v, --version        show version`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      print: { type: 'string', short: 'p' },
      continue: { type: 'boolean', short: 'c', default: false },
      host: { type: 'string' },
      ctx: { type: 'string' },
      yolo: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log('rootcode 0.1.0');
    return;
  }

  const config = loadConfig();
  if (values.model) config.model = values.model;
  if (values.host) config.host = values.host;
  if (values.ctx && Number(values.ctx) > 0) config.numCtx = Number(values.ctx);
  if (values.yolo) config.yolo = true;

  const agent = new Agent(config);

  let resumeNotice: string | undefined;
  if (values.continue) {
    const session = latestSession(process.cwd());
    if (session) {
      agent.restoreSession(session);
      resumeNotice = `resumed session from ${formatAge(session.updatedAt)}: "${session.title}" (${session.messages.length} messages)`;
    } else {
      resumeNotice = 'no previous session found in this directory — starting fresh';
    }
  }

  if (values.print !== undefined) {
    if (resumeNotice) console.error(chalk.dim(resumeNotice));
    await runHeadless(agent, values.print, config.yolo);
    return;
  }

  const initialPrompt = positionals.join(' ').trim() || undefined;
  render(<App agent={agent} initialPrompt={initialPrompt} resumeNotice={resumeNotice} />, { exitOnCtrlC: false });
}

async function runHeadless(agent: Agent, prompt: string, yolo: boolean): Promise<void> {
  const callbacks: AgentCallbacks = {
    onText: () => {},
    onTextDone: (text) => {
      if (text.trim()) console.log(text.trim() + '\n');
    },
    onToolStart: (_id, _name, title) => console.error(chalk.dim(`⏺ ${title}`)),
    onToolEnd: (_id, _name, _title, output, isError) => {
      if (isError) console.error(chalk.red(`  ✗ ${output.split('\n')[0]}`));
    },
    // Reached only when yolo is off: deny mutating tools in headless mode.
    onPermission: async (req) => {
      console.error(chalk.yellow(`  ✋ denied (needs approval): ${req.title} — rerun with --yolo to allow`));
      return 'deny';
    },
    onStatus: () => {},
  };

  process.on('SIGINT', () => {
    agent.abort();
  });

  try {
    await agent.run(prompt, callbacks);
  } catch (err) {
    if (err instanceof InterruptedError) {
      console.error(chalk.yellow('interrupted'));
      process.exitCode = 130;
      return;
    }
    console.error(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
  void yolo;
}

main().catch((err) => {
  console.error(chalk.red(`fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
