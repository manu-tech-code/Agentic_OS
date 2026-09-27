import { onDay } from '../when.ts';
import type { ActionRecord, Skill, SkillContext } from './types.ts';

/**
 * Trust: taking things back ("undo that"), what Nova did ("what did you do today?"), stopping
 * everything at once, and what the user lets Nova do without asking.
 */

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** What "undo" means: the last undoable thing - of the agent named, if one is. */
const undoing = (ctx: SkillContext): ActionRecord | null => ctx.actions?.lastUndoable(ctx.agent?.label) ?? null;

/** Taking back something from a while ago is asked about first, as is putting back files. */
const A_WHILE_MS = 3_600_000;
const aWhileAgo = (ctx: SkillContext, action: ActionRecord) => ctx.platform.now().getTime() - action.at > A_WHILE_MS;

/** Which days a question is about: today, yesterday, this week. */
function days(said: string) {
  if (/\byesterday\b/i.test(said)) return { days: 2, from: 1, label: 'yesterday' };
  if (/\bthis week\b|\blately\b|\brecently\b/i.test(said)) return { days: 7, from: 0, label: 'this week' };
  return { days: 1, from: 0, label: 'today' };
}

const startOfDay = (at: Date, back: number) => new Date(at.getFullYear(), at.getMonth(), at.getDate() - back).getTime();

const base = (path: string) => path.split('/').pop() ?? path;

/** Asking about the record isn't something done. */
const READS = ['activity_report', 'permissions'];

/** The files an agent changed, as said: "server.ts, nova.ts and 3 more". */
const changed = (files: string[]) => list(files.length > 4 ? [...files.slice(0, 3).map(base), `${files.length - 3} more`] : files.map(base));

/** An action as said after "I did…" - or after "Claude did…", without the agent's name again. */
function told(action: ActionRecord, by: string | undefined, names: string[]) {
  let label = action.label;
  if (by && label.startsWith(by)) label = label.slice(by.length).replace(/^[:\s]+/, '');
  // Nova's own wording starts with a verb ("Opened Slack"); a name ("Claude finished…") keeps its capital.
  else if (!names.some((n) => label.startsWith(n))) label = label.replace(/^./, (c) => c.toLowerCase());
  return `${label}${action.files?.length ? ` (${action.files.length === 1 ? base(action.files[0]!) : `${action.files.length} files`} changed)` : ''}`;
}

export const trustSkills: Skill[] = [
  {
    id: 'undo',
    summary: 'Take back the last thing Nova did that can be undone (or the last thing a named agent did).',
    tier: 1,
    // Putting files back changes a project, and something from a while ago may not be what the user means: asked first.
    tierFor: (ctx) => {
      const action = undoing(ctx);
      return action && (action.files?.length || aWhileAgo(ctx, action)) ? 2 : 1;
    },
    confirmPrompt: (ctx) => {
      const action = undoing(ctx);
      if (!action) return 'Undo that?';
      const when = aWhileAgo(ctx, action) ? `, done ${onDay(new Date(action.at), ctx.platform.now())}` : '';
      const files = action.files?.length;
      return files ? `Put back ${files === 1 ? `${base(action.files![0]!)}` : `the ${files} files`} as ${files === 1 ? 'it was' : 'they were'} before "${action.label}"${when}?` : `Undo "${action.label}"${when}?`;
    },
    examples: ['undo that', 'undo', 'take that back', 'revert that', 'undo what claude did', 'put it back the way it was'],
    async run(ctx) {
      const action = undoing(ctx);
      if (!action || !ctx.actions) return { say: ctx.agent ? `There's nothing of ${ctx.agent.label}'s to undo.` : "There's nothing I can undo.", activity: 'Undo: nothing' };
      const result = await ctx.actions.undo(action.id);
      return { say: result.message, activity: result.ok ? `Undid: ${action.label}` : `Couldn't undo: ${action.label}` };
    },
  },
  {
    id: 'activity_report',
    summary: 'What Nova did - today, yesterday or this week - and who asked for each thing. Put the question in request.',
    tier: 0,
    informs: true,
    examples: ['what did you do today', 'what have you done', 'what did claude change', 'what happened today', 'what did you do while i was away'],
    async run(ctx) {
      const now = ctx.platform.now();
      const range = days(ctx.utterance);
      const from = startOfDay(now, range.from);
      const to = range.label === 'yesterday' ? startOfDay(now, 0) : Infinity;
      const by = ctx.agent?.label;
      // What was done - not reading the record itself.
      const done = (ctx.actions?.recent(range.days) ?? []).filter(
        (a) => a.at >= from && a.at < to && a.status !== 'pending' && !READS.includes(a.skill ?? '') && (!by || a.by === by),
      );
      const names = [...(ctx.agents ?? []).map((a) => a.label), ...done.map((a) => a.by ?? '').filter((b) => b && b !== 'you' && !b.startsWith('routine:'))];
      if (!done.length) return { say: `${by ? `${by} did` : 'I did'} nothing ${range.label}.`, data: 'Nothing in the record.', activity: 'Read the record' };
      const said = done.slice(0, 6).map((a) => told(a, by, names));
      const undone = done.filter((a) => a.undone).length;
      const files = [...new Set(done.flatMap((a) => a.files ?? []))];
      return {
        say:
          `${range.label === 'today' ? 'Today' : range.label === 'yesterday' ? 'Yesterday' : 'This week'} ${by ?? 'I'} did ${done.length === 1 ? 'one thing' : `${done.length} things`}${done.length > 6 ? ' - the latest' : ''}: ${said.join('; ')}.` +
          `${by && files.length ? ` Altogether ${by} changed ${changed(files)}.` : ''}${undone ? ` ${undone === 1 ? 'One was' : `${undone} were`} undone.` : ''}`,
        data: done
          .map((a) => {
            const who = a.by && !(by && a.by === by) ? ` (asked by ${a.by})` : '';
            const state = a.status === 'failed' ? ' · failed' : a.undone ? ' · undone' : a.undoable ? ' · can be undone' : '';
            return `${onDay(new Date(a.at), now)} · ${a.label}${who}${a.files?.length ? ` · changed ${a.files.join(', ')}` : ''}${state}`;
          })
          .join('\n'),
        activity: 'Read the record',
      };
    },
  },
  {
    id: 'stop_everything',
    summary: 'Stop everything at once: agent tasks, questions waiting, speaking, routines - and mute the microphone.',
    tier: 0,
    examples: ['stop everything', 'stop it all', 'emergency stop', 'halt everything', 'kill everything now', 'shut it all down'],
    async run(ctx) {
      const tasks = ctx.halt?.() ?? 0;
      return {
        say: `Stopped everything${tasks ? `, including ${tasks === 1 ? 'the agent task' : `${tasks} agent tasks`}` : ''}. The microphone is muted - press the shortcut when you need me.`,
        activity: 'Stopped everything',
      };
    },
  },
  {
    id: 'permissions',
    summary: 'What the user lets Nova do without asking (what they said "yes, always" to).',
    tier: 0,
    informs: true,
    examples: ['what have i allowed', 'what can you do without asking', 'what permissions have i given you', 'what did i say always to'],
    async run(ctx) {
      const rules = ctx.trust?.list() ?? [];
      if (!rules.length) return { say: 'Nothing - I ask before anything risky.', data: 'No remembered permissions.', activity: 'Read permissions' };
      return {
        say: `Without asking, I may: ${list(rules.slice(0, 5).map((r) => `${r.label.replace(/^./, (c) => c.toLowerCase())}${r.until ? ' (today)' : ''}`))}${rules.length > 5 ? `, and ${rules.length - 5} more` : ''}. You can take any of them back in Settings → Privacy & trust.`,
        data: rules.map((r) => `- ${r.label}${r.until ? ` (until the end of ${r.until})` : ''}`).join('\n'),
        activity: 'Read permissions',
      };
    },
  },
];

/** "Yes, always" or "yes, for today", in a yes to one of Nova's questions. Read in code, from the user's own words. */
export function alwaysIn(said: string): 'always' | 'today' | null {
  if (/\b(?:always|every time|from now on|don'?t ask (?:me )?again|never ask|for good)\b/i.test(said)) return 'always';
  if (/\b(?:for today|just today|today only|for the (?:rest of the )?day|until tomorrow)\b/i.test(said)) return 'today';
  return null;
}

/** Agent commands "yes, always" never covers: deleting, force, superuser, piping downloads into a shell. */
export const RISKY_COMMAND =
  /(?:^|[\s;&|(])(?:rm|rmdir|sudo|su|chmod|chown|dd|mkfs|diskutil|kill|killall|pkill|shutdown|reboot|launchctl|crontab)\b|git\s+(?:push|reset\s+--hard|clean|checkout\s+--|branch\s+-D|rebase)|--force\b|\s-f\b|(?:curl|wget)\b[^|]*\|\s*(?:sh|bash|zsh|python)|npm\s+(?:publish|unpublish)|drop\s+(?:table|database)|>\s*\/dev\//i;
