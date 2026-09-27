import { onDay } from '../when.ts';
import type { ActionRecord, Skill, SkillContext } from './types.ts';

/**
 * Trust: taking things back ("undo that"), what Nova did ("what did you do today?"), stopping
 * everything at once, and what the user lets Nova do without asking.
 */

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** What "undo" means: the action settled when it was asked (a yes takes back that one), else the last undoable - of the agent named, if one is. */
const lastUndoable = (ctx: SkillContext): ActionRecord | null => ctx.actions?.lastUndoable(ctx.agent?.label) ?? null;
const undoing = (ctx: SkillContext): ActionRecord | null => (ctx.prepared !== undefined ? (ctx.prepared as ActionRecord | null) : lastUndoable(ctx));

/** Taking back something from a while ago is asked about first, as is putting back files. */
const A_WHILE_MS = 3_600_000;
const aWhileAgo = (ctx: SkillContext, action: ActionRecord) => ctx.platform.now().getTime() - action.at > A_WHILE_MS;

/** Which days a question is about: today, yesterday, this week (today and the six days before). `from`: days back it starts. */
function days(said: string) {
  if (/\byesterday\b/i.test(said)) return { days: 2, from: 1, label: 'yesterday' };
  if (/\bthis week\b|\blately\b|\brecently\b/i.test(said)) return { days: 7, from: 6, label: 'this week' };
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
    summary: 'Take back the last thing Nova did that can be undone - or, with agent, the last thing that agent did.',
    tier: 1,
    namesAgent: true,
    prepare: lastUndoable,
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
    summary: 'What Nova did - today, yesterday or this week - and who asked for each thing. Put the question in request; agent for what one agent did.',
    tier: 0,
    informs: true,
    namesAgent: true,
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

const ALWAYS = /\b(?:always|every\s+time|from\s+now\s+on|(?:don'?t|do\s+not|never)\s+ask(?:\s+me)?(?:\s+again)?|for\s+good)\b/gi;
const TODAY = /\b(?:for\s+today|just\s+today|today\s+only|for\s+the\s+(?:rest\s+of\s+the\s+)?day|until\s+tomorrow)\b/gi;
/** Words before a scope, in its clause, that take it back: "not always", "but ask me every time". */
const UNSAYS = /\b(?:not|never|no|don'?t|do\s+not|doesn'?t|stop|ask|asking|check|confirm)\b/i;

/** Whether a scope is said and meant: not negated or contradicted in its clause ("not always", "always ask me"). */
function meant(scope: RegExp, said: string) {
  for (const m of said.matchAll(scope)) {
    const clause = said.slice(0, m.index).split(/\b(?:but|except|though|although|however)\b|[.;!?]/i).at(-1) ?? '';
    const after = said.slice(m.index + m[0].length);
    if (!UNSAYS.test(clause) && !/^[\s,]*(?:ask|check|confirm|make\s+sure)\b/i.test(after)) return true;
  }
  return false;
}

/** "Yes, always" or "yes, for today", in a yes to one of Nova's questions. Read in code, from the user's own words. */
export function alwaysIn(said: string): 'always' | 'today' | null {
  if (meant(ALWAYS, said)) return 'always';
  if (meant(TODAY, said)) return 'today';
  return null;
}

/**
 * "Go ahead with all of it" to one step of a task on the computer: the rest of that task needn't
 * ask. Never remembered past the task.
 */
export function taskScope(said: string): boolean {
  return /\b(?:(?:go ahead|carry on|continue|keep going|do it|yes)\s+(?:with\s+)?(?:all of it|all of them|everything|the rest|the whole (?:thing|lot|task))|yes to (?:all|everything)|all of it|the whole thing|for (?:the rest of )?(?:this|the) task|(?:don'?t|no need to) (?:keep )?ask(?:ing)? (?:me )?(?:again )?(?:for|during|until the end of) (?:this|the rest)|stop asking(?: me)?(?: for this)?|every step)\b/i.test(said);
}

const GIT = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*`;

/**
 * Agent commands "yes, always" never covers: deleting (however it's spelled - /bin/rm, \rm, find -delete),
 * throwing away work in git, force, superuser, piping downloads into a shell.
 */
export const RISKY_COMMAND = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60'"])(?:[\w.~-]*\/)*\\?(?:rm|rmdir|unlink|shred|truncate|rimraf|sudo|su|doas|chmod|chown|chgrp|dd|mkfs(?:\.\w+)?|diskutil|kill|killall|pkill|shutdown|reboot|halt|launchctl|crontab)(?=\s|$|[;&|)'"\x60])`,
    String.raw`\bfind\b[^;&|]*\s-(?:delete|exec(?:dir)?\s+rm)\b`,
    `${GIT}(?:push|reset\\s+--(?:hard|merge|keep)|clean|checkout\\s+(?:--|\\.|-f\\b)|restore|stash\\s+(?:drop|clear)|branch\\s+-D|rebase|filter-branch|update-ref\\s+-d|reflog\\s+(?:expire|delete)|gc\\s+--prune)`,
    String.raw`--force\b|\s-f\b`,
    String.raw`(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?|node)\b`,
    String.raw`npm\s+(?:publish|unpublish)`,
    String.raw`drop\s+(?:table|database|schema)`,
    String.raw`>\s*\/dev\/`,
    String.raw`\bmv\b[^;&|]*\s\/dev\/`,
  ].join('|'),
  'i',
);
