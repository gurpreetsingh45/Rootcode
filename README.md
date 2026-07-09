# ✻ rootcode

A local CLI coding agent powered by [Ollama](https://ollama.com) — like Claude Code, but running entirely on your machine. No API keys, no cloud, your code never leaves your computer.

Built with TypeScript + [Ink](https://github.com/vadimdemedes/ink) (the same terminal UI framework Claude Code uses).

## Features

- **Agentic loop** — the model plans, calls tools, reads results, and keeps going until the task is done
- **9 built-in tools** — `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`, `todo_write`, `fetch_url`
- **Permission system** — file writes, shell commands, and network access ask for approval first, with colorized diff previews; approve once, always for the session, or deny. `--yolo` / `/yolo` skips prompts
- **Rich terminal UI** — streaming responses, markdown rendering with syntax-highlighted code blocks, live todo list, spinner and status bar with token/context usage
- **Session management** — conversations auto-save per directory; `rootcode -c` resumes the latest one and `/resume` lists and restores past sessions. `/compact` summarizes history to free context, `/clear` starts fresh, automatic pruning keeps you inside the context window
- **Input niceties** — persistent history (up/down), slash-command completion (tab), multiline input (`\` + enter), esc to interrupt the agent mid-task
- **Headless mode** — `rootcode -p "..."` for scripting and pipelines
- **Project instructions** — put a `ROOTCODE.md` (or `AGENTS.md`/`CLAUDE.md`) in your repo and it's loaded into the system prompt

## Requirements

- Node.js ≥ 20
- [Ollama](https://ollama.com) running locally with a **tool-calling capable** model:

```bash
ollama pull qwen2.5-coder:7b   # recommended default
# also good: qwen2.5-coder:14b/32b, llama3.1, mistral-nemo, devstral
```

## Install

```bash
npm install
npm run build
npm link        # makes the `rootcode` command available globally
```

## Usage

```bash
cd your/project
rootcode                        # interactive session
rootcode "fix the failing test" # interactive, starts on a task
rootcode -c                     # resume the most recent session in this directory
rootcode -p "explain src/app.ts"          # headless: one prompt, print, exit
rootcode -p "add a .gitignore" --yolo     # headless with writes allowed
rootcode -c -p "now add tests for it"     # headless, continuing the last session
rootcode -m llama3.1 --ctx 32768          # pick model / context size
```

### Slash commands

| Command | Description |
| --- | --- |
| `/help` | show help |
| `/model <name>` | switch model (persisted to config) |
| `/models` | list installed Ollama models |
| `/tools` | list available tools |
| `/clear` | reset the conversation |
| `/resume` | list past sessions in this directory; `/resume <n>` restores one |
| `/compact` | summarize history to free context |
| `/yolo` | toggle auto-approval of all tools |
| `/exit` | quit |

### Keys

| Key | Action |
| --- | --- |
| `esc` | interrupt the agent while it's working |
| `up` / `down` | input history |
| `tab` | complete slash command |
| `\` + `enter` | insert newline |
| `ctrl+c` twice | quit |

## Configuration

`~/.config/rootcode/config.json`:

```json
{
  "model": "qwen2.5-coder:7b",
  "host": "http://127.0.0.1:11434",
  "numCtx": 16384,
  "temperature": 0.2
}
```

`numCtx` matters: Ollama defaults to a small context window; rootcode requests 16k by default. Raise it if your machine has the memory (`--ctx 32768`), lower it if the model runs slowly.

## Development

```bash
npm run dev          # run from source with tsx
npm test             # run the test suite (node:test via tsx)
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
```

## Architecture

```
src/
  index.tsx        entry point: arg parsing, interactive vs headless mode
  agent.ts         the agentic loop: streaming chat, tool dispatch, permissions, context pruning
  tools.ts         tool schemas + implementations
  systemPrompt.ts  system prompt with environment context and project instructions
  sessions.ts      conversation persistence (~/.local/share/rootcode/sessions/)
  config.ts        ~/.config/rootcode/config.json
  history.ts       persistent input history
  ui/
    App.tsx        main Ink component: transcript, input, permission dialogs, status bar
    Input.tsx      custom text input: cursor, history, slash completion
    components.tsx spinner, diff view, todo panel, permission prompt, transcript items
    markdown.ts    markdown → ANSI renderer with syntax highlighting
```

## Notes on local models

Small local models are far weaker than frontier models at multi-step agentic work. Tips:

- `qwen2.5-coder:7b` is a good floor; 14b/32b are meaningfully better if you have the VRAM
- Keep tasks small and concrete ("add a --verbose flag to cli.py") rather than open-ended
- The model must support tool calling — models without it will error with a clear message
