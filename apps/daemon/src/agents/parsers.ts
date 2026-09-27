import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import type { AgentStep } from '@nova/core';
import type { OutputFormat } from './presets.ts';

/** Reads an agent's stdout line by line: live steps as they happen, then the final answer or error. */
export interface OutputReader {
  line(line: string): AgentStep | null;
  /** Answer text as it's written, from CLIs that stream it. */
  delta?(line: string): string | null;
  result(): { text: string; error?: string };
}

/** A text piece from Claude Code's partial messages (--include-partial-messages). */
export function claudeDelta(line: string): string | null {
  if (!line.includes('text_delta')) return null;
  const e = json(line);
  return e?.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta' ? String(e.event.delta.text ?? '') : null;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const base = (path?: string) => (path ? path.split('/').pop()! : 'a file');
const firstSentence = (text: string) => clip(text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '', 80);
/** "bash -lc 'npm test'" -> "npm test" */
const unwrapShell = (cmd: string) => cmd.replace(/^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/, '$2');

function json(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** A Claude Code tool call in plain words. */
export function describeTool(name: string, input: any): AgentStep {
  switch (name) {
    case 'Bash':
      return { kind: 'command', text: `running ${clip(String(input?.command ?? 'a command'))}` };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'edit', text: `editing ${base(input?.file_path ?? input?.notebook_path)}` };
    case 'Read':
      return { kind: 'read', text: `reading ${base(input?.file_path)}` };
    case 'Glob':
    case 'Grep':
      return { kind: 'search', text: 'searching the code' };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'search', text: 'searching the web' };
    case 'TodoWrite':
      return { kind: 'other', text: 'planning the work' };
    default:
      return { kind: 'other', text: `using ${name}` };
  }
}

/** Longest command Nova reads out to be allowed; a longer one is sent back to be split up. */
export const MAX_SPOKEN_COMMAND = 300;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Why a permission prompt can't be put to the user as it is (a command too long to say), or null. */
export function tooLongToSay(tool: string, input: any): string | null {
  if (tool !== 'Bash') return null;
  const command = oneLine(String(input?.command ?? ''));
  return command.length > MAX_SPOKEN_COMMAND
    ? `Not run: this command is too long (${command.length} characters) for the user to hear in full and approve by voice. Run it as shorter commands, one step at a time (at most ${MAX_SPOKEN_COMMAND} characters each).`
    : null;
}

/** A file, as the user should hear it: inside the project from its folder, anywhere else in full from ~ - and said to be outside. */
function whereIs(file: unknown, project?: string): string {
  if (typeof file !== 'string' || !file) return 'a file';
  const path = resolve(project ?? '/', expandHome(file));
  if (project && (path === project || path.startsWith(project.endsWith(sep) ? project : project + sep))) return relative(project, path) || '.';
  const home = homedir();
  const shown = path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
  return project ? `${shown}, outside the project` : shown;
}
const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);

/** What a permission prompt asks for, phrased to follow "wants to" - all of it: what's said is what's allowed. */
export function describeAction(tool: string, input: any, project?: string): string {
  switch (tool) {
    case 'Bash':
      return `run "${oneLine(String(input?.command ?? ''))}"`;
    case 'WebFetch':
      return `open ${input?.url ?? 'a web page'}`;
    case 'WebSearch':
      return `search the web for "${clip(String(input?.query ?? ''), 80)}"`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool === 'Write' ? 'write' : 'edit'} ${whereIs(input?.file_path ?? input?.notebook_path, project)}`;
    default:
      return `use ${tool}`;
  }
}

/**
 * Exactly what an agent's request is, for remembering a "yes, always": the command, the site, the
 * file. Nothing for a tool whose input doesn't narrow it down (then "always" covers that tool).
 */
export function approvalDetail(tool: string, input: any): string {
  switch (tool) {
    case 'Bash':
      return String(input?.command ?? '').replace(/\s+/g, ' ').trim();
    case 'WebFetch':
      try {
        return new URL(String(input?.url ?? '')).hostname;
      } catch {
        return String(input?.url ?? '');
      }
    case 'WebSearch':
      return '*';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return String(input?.file_path ?? input?.notebook_path ?? '');
    default:
      return '';
  }
}

export function outputReader(format: OutputFormat): OutputReader {
  switch (format) {
    case 'claude':
      return claudeReader();
    case 'codex':
      return codexReader();
    case 'opencode':
      return opencodeReader();
    case 'text':
      return textReader();
  }
}

/** claude -p --output-format stream-json --verbose */
function claudeReader(): OutputReader {
  let text = '';
  let final: string | undefined;
  let error: string | undefined;
  return {
    line(line) {
      const e = json(line);
      if (e?.type === 'assistant') {
        let step: AgentStep | null = null;
        for (const block of e.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            text = block.text;
            step ??= { kind: 'message', text: firstSentence(block.text) };
          }
          if (block.type === 'tool_use') step = describeTool(block.name, block.input);
        }
        return step;
      }
      if (e?.type === 'result') {
        final = typeof e.result === 'string' ? e.result : undefined;
        if (e.is_error) error = final || e.subtype || 'Claude Code failed';
      }
      return null;
    },
    delta: claudeDelta,
    result: () => ({ text: final ?? text, error }),
  };
}

/** codex exec --json: thread / turn / item events. */
function codexReader(): OutputReader {
  let text = '';
  let error: string | undefined;
  return {
    line(line) {
      const e = json(line);
      if (!e) return null;
      if (e.type === 'turn.failed' || e.type === 'error') {
        error = e.error?.message ?? e.message ?? 'Codex failed';
        return null;
      }
      const item = e.item;
      const started = e.type === 'item.started';
      const completed = e.type === 'item.completed';
      if (!item || (!started && !completed)) return null;
      switch (item.type) {
        case 'agent_message':
          if (!completed || !item.text) return null;
          text = item.text;
          return { kind: 'message', text: firstSentence(item.text) };
        case 'command_execution':
          return started ? { kind: 'command', text: `running ${clip(unwrapShell(String(item.command ?? '')))}` } : null;
        case 'file_change':
          return completed ? { kind: 'edit', text: `editing ${(item.changes ?? []).map((c: any) => base(c.path)).join(', ') || 'files'}` } : null;
        case 'web_search':
          return started ? { kind: 'search', text: 'searching the web' } : null;
        case 'mcp_tool_call':
          return started ? { kind: 'other', text: `using ${item.tool ?? 'a tool'}` } : null;
        default:
          return null;
      }
    },
    result: () => ({ text, error }),
  };
}

/** opencode run --format json, read defensively: text parts become the answer, tool parts become steps. */
function opencodeReader(): OutputReader {
  let text = '';
  let error: string | undefined;
  return {
    line(line) {
      const e = json(line);
      if (!e) return null;
      if (e.type === 'error') {
        error = e.error?.data?.message ?? e.error?.message ?? String(e.error ?? 'OpenCode failed');
        return null;
      }
      const part = e.part ?? e;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        text = part.text;
        return null;
      }
      if (part.type === 'tool' || e.type === 'tool_use') {
        const input = part.state?.input ?? {};
        const tool = String(part.tool ?? 'a tool');
        if (tool === 'bash') return { kind: 'command', text: `running ${clip(String(input.command ?? ''))}` };
        if (tool === 'edit' || tool === 'write') return { kind: 'edit', text: `editing ${base(input.filePath)}` };
        return { kind: 'other', text: `using ${tool}` };
      }
      return null;
    },
    result: () => ({ text, error }),
  };
}

function textReader(): OutputReader {
  const lines: string[] = [];
  return { line: (l) => (lines.push(l), null), result: () => ({ text: lines.join('\n') }) };
}
