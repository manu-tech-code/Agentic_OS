# Nova

A voice-first, model-agnostic agentic OS layer. You talk; it acts.

- **System 1 - fast decisions.** Every utterance gets one typed decision call (intent, target app, "was that meant for me?") through a swappable `DecisionEngine`. Default: **Jev** via Vercel AI Gateway. Fallbacks: any LLM with a schema, or an offline heuristic.
- **System 2 - reasoning.** Open questions go to any model you plug in (Claude, GPT, Gemini, local).
- **Paired agents.** Claude Code, Codex, OpenCode, Gemini CLI or any agent CLI answer questions and do project
  tasks in the background - narrated live, with risky steps asked out loud.
- **Glass UI.** macOS-inspired shell: the Orb, Live Pill, frosted cards, magnifying dock, Decision Inspector.

Design docs and decisions are in `doc/` as PDFs.

## Layout

```
packages/core     brain: DecisionEngine (Jev / LLM / heuristic), NovaBrain orchestrator, skills, guardian, protocol
apps/daemon       local service: WebSocket API on 127.0.0.1:7878, macOS app control, agent pairing, jev:ping latency spike
apps/desktop      React + Vite glass UI (runs in a browser, or inside Nova.app)
apps/desktop/macos  Nova.app: Nova in the menu bar - its microphone and speaker, the ⌥Space shortcut, the floating orb
```

One core, many shells: the desktop app, a web app and future IDE extensions are all thin clients of the daemon.

## Run it

Requires Node 22+; Nova.app and the Mac helpers need Xcode (or its Command Line Tools) for Swift.

```bash
npm install
npm run dev                   # daemon + UI
```

No `.env` needed: it only holds constants such as an AI Gateway key (see `.env.example`). Everything else is a setting.

Open **http://localhost:5173** in Safari, Chrome or Edge (any browser with the Web Speech API) and allow the
microphone - Nova starts listening on its own. Then say:

- "Hey Nova, open Slack"
- "Nova, what time is it?"
- "Nova, set a timer for 5 minutes"
- "Nova, quit Spotify" → "yes"  (tier-2 action: spoken confirmation)
- "Hey Nova" … pause … "open Figma"  (after the wake word or a reply, Nova listens 30 s without it)

Voice setup, once per browser:
- **Stop the permission prompt:** Safari → Settings → Websites → Microphone → `localhost` → **Allow**.
  Chrome/Edge: allow the microphone on every visit (the icon at the left of the address bar).
- **Safari** also needs Dictation on for speech recognition: System Settings → Keyboard → Dictation.
- Browsers only play sound after one click or key press per visit, so click anywhere once to hear replies (Nova shows a
  reminder when a reply is waiting for that click). Safari can skip it: Settings → Websites → Auto-Play → `localhost` → Allow All Auto-Play.
- **Stop listening:** click the microphone in the dock or say "stop listening" - the microphone is released, not just
  muted, and stays off until you click it again. Typing (⌘K) still works while it's off.

Wake word: Settings → Voice sets how long Nova listens without it after replying (30 s by default), or drops it
entirely (conversation mode) - Nova's "was that for me?" check then filters background speech, which works best
with Jev or local-model decisions rather than the keyword matcher.

Press **⌘K** to type instead, **⌘I** for the Decision Inspector, **⌘J** for Activity, **Esc** to stop.
`http://localhost:5173/#demo` plays a scripted session with no daemon, for design work.

For Nova in the menu bar - always there, no browser tab - build **Nova.app** with `npm run app` (below).

## Settings

Click ⚙ in the dock or say "open settings" (⌘, works in the native window; browsers keep it for their own settings).
Everything is configurable there and applies immediately, without a restart:

- **Setup** - what's set up and what isn't, with the fix for each, and the first-run walkthrough again.
- **General** - the assistant's name. It answers to "hey <name>", "okay <name>" and the name, unless you set your own wake words.
- **Voice** - Kokoro's voices (Nova's voice, inside Nova.app), wake words, conversation mode, how long it keeps listening after replies, listening on open and speaking rate.
- **Hearing** - how Nova turns speech into text: Apple's on-device recognizer, Parakeet, or the browser's own; the language; how long it waits when you pause; Smart Turn; talking over Nova.
- **Appearance** - the Orb: a sphere of thousands of moving dots drawn by the GPU (or the classic glass orb), its colours and how much it moves. It breathes when idle, ripples with your voice, swirls while thinking and moves with its voice as it speaks.
- **Decisions / Answers** - the decision engine, and who answers open questions: automatically your default paired agent, or any agent, local model or cloud model.
- **Integrations** - services the brains can use through Nova (Notion, Linear, GitHub, ...): sign-in, and when Nova asks you first.
- **Local models** - LM Studio, Ollama, oMLX, mlx_lm, llama.cpp and any server you add: whether it's running, which models it offers, keys.
- **Agents** - which are paired, the default, and each one's model, extra arguments and CLI path, plus your own agent CLIs.
- **Projects** - the folders agents may work in. **Cloud gateway** - whether the optional Vercel key is set.
- **Privacy & trust** - what leaves the Mac and where it goes (a switch for each), what Nova may do without asking (revoke any), how long the record of actions is kept, and snapshots for undoing agents' changes.

Your settings live in `~/.nova/settings.json`: plain JSON holding only what you've changed, so it's also fine to edit by
hand - Nova applies the file as soon as you save it. Anything it can't use falls back to its default, and Settings says why.
The keys, defaults and allowed values are defined in `packages/core/src/settings.ts`.

```json
{
  "name": "Jarvis",
  "voice": { "followUpSeconds": 20, "speaker": "Samantha" },
  "answers": { "model": "claude" },
  "models": { "servers": { "omlx": { "url": "http://localhost:8000/v1" } } },
  "agents": { "enabled": ["claude", "codex"], "options": { "codex": { "args": "--oss --local-provider lmstudio" } } },
  "projects": { "named": { "site": "~/work/site" } }
}
```

`.env` holds only constants: API keys (`AI_GATEWAY_API_KEY`, `NOVA_<SERVER>_API_KEY`), the port (`NOVA_PORT`), the windows
allowed to change settings (`NOVA_UI_ORIGINS`) and file locations (`NOVA_SETTINGS_FILE`, `NOVA_AGENTS_FILE`); changing it
needs a restart. Settings shows whether each key is set, never its value, and only Nova's own window (or a program on your
Mac) can change settings. Settings kept in `.env` by earlier versions (`NOVA_NAME`, `NOVA_BRAIN_MODEL`, ...) are moved into
the settings file once and ignored after that; the daemon lists the ones you can delete.

## Nova's voice (Kokoro)

Nova speaks with [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache-2.0), a small neural voice
that sounds close to a real person and runs on your Mac: free, private, and quick enough to start within a moment of the
reply. It's Nova's only voice, and it comes inside Nova.app - `npm run app` puts it in the app (from `~/.nova/models`
when it's already there, as an APFS clone that takes no extra space; otherwise it's fetched once, checked against its
pinned checksums, while the app is built). There's nothing to download in Nova itself.

The daemon speaks each reply sentence by sentence and streams the audio to Nova.app (or every window), so talking starts
after the first sentence, and the Orb moves with how loud the voice actually is. Pick a voice in Settings → Voice
(Heart, Bella, Michael, Emma, George, ...) and press Preview. Without Kokoro - running only the web window, without
Nova.app - replies are shown, not spoken; `npm run voice:download` puts Kokoro in `~/.nova/models` for that case.

## Hearing on your Mac

Nova hears you on the Mac itself: the window streams its microphone (with echo cancellation) to the daemon, which turns
speech into text and decides when you've finished. Nothing you say leaves the Mac. Choose the engine in Settings → Hearing:

- **Apple's on-device recognizer** (the default on macOS 26 and later): live text as you speak, a vocabulary of your app,
  agent and project names, and nothing to download - it uses the language models macOS already has. Nova never downloads
  one behind your back: for a language whose model isn't on the Mac, turn on Dictation for it in System Settings.
- **Parakeet** ([NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml),
  CC-BY-4.0) on the Neural Engine: the most accurate in a noisy room, with a draft of your words every ¾ second. English.
- **The browser's speech recognition**: the fallback, used automatically while on-device hearing starts or if it can't.

```bash
npm run hearing:download      # Parakeet (464 MB) and Smart Turn (9 MB) - or Settings → Hearing → Install
npm run hearing:build         # the hearing helper; Nova also builds it by itself the first time (a few minutes)
```

When you pause, Nova waits a moment if your words sound complete and longer if you trail off ("in my current project I
want to…"). [Smart Turn](https://huggingface.co/pipecat-ai/smart-turn-v3) (BSD-2) listens to your tone as well, so it can
tell a finished sentence from a thinking pause in about 30 ms. You can talk over Nova to stop it mid-sentence - a stop
word or a couple of words of your own do it - and Nova never mistakes its own voice for yours. Settings → Hearing sets how
patient it is, and turns Smart Turn and talking over Nova on or off.

The recognizers run in a small Swift helper (`apps/daemon/native/hearing`), built on this Mac with Xcode's Swift. Parakeet
runs through [FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0), fetched at a pinned commit and built
without its optional prebuilt text-normalization binary, which hearing doesn't need. Models download from pinned revisions
and are checked against their checksums, into `~/.nova/models`.

## Integrations

Every brain - Claude, Codex, OpenCode, a local model - can use your services through Nova: Settings → Integrations,
pick one, and it's offered to all of them. Each is an MCP server, hosted or started on your Mac:

- **Sign in with the browser**: Notion, Linear, Jira & Confluence, Sentry, Supabase, Vercel, Figma. Nova registers itself
  with the service and opens its sign-in page; you sign in yourself, and Nova keeps only the access it was given (in
  `~/.nova/integration-tokens.json`, readable by you alone). Sign out any time.
- **Your own token**: GitHub (a personal access token) and Stripe (a restricted key). Put it in `.env` - for example
  `NOVA_GITHUB_TOKEN=...` - and the settings only name it (`Bearer ${NOVA_GITHUB_TOKEN}`); press Retry to pick it up.
- **No sign-in**: Hugging Face and Cloudflare's docs.
- **Anything else**: any MCP server's address, or the command that starts one on your Mac (`npx -y some-mcp-server`).
  Local servers get a clean environment - Nova's own keys never reach them.

Nova asks you out loud before each action a brain takes through a service ("Codex wants to use Linear: create issue 'Fix
the login bug'. Allow it?"), unless you say otherwise: per service, *only before changes* (tools the service itself
labels read-only run without asking) or *never*, and per tool, *allow*, *ask first* or *block* (a blocked tool is kept
from the brains entirely). Paired agents that stay running are refreshed between questions when a service's tools change.

## Nova in the menu bar (Nova.app)

```bash
npm run app        # builds the window and Nova.app on this Mac, puts it in ~/Applications and opens it
```

Nova.app makes Nova part of the Mac rather than a page:

- **It listens for its name from anywhere**, with no window open. The microphone runs through Apple's voice
  processing and Nova's replies play through the same audio engine, so its echo canceller takes Nova's own voice out
  of what the microphone hears - you can talk over Nova. macOS shows its orange dot while it listens; it pauses while
  the Mac is locked or asleep, and **Mute the Microphone** in its menu turns it off until you turn it back on (saying
  "stop listening" does the same). What it hears is turned into text on the Mac, as before.
- **⌥Space** (Settings → Menu bar → Shortcut): hold it while you talk and let go when you're done, or tap it and just
  talk; tap it again to stop listening. Pressing it while Nova speaks cuts Nova off. It needs no permission, and it
  works even while the microphone is muted.
- **The orb** floats in a corner of the screen with what Nova hears and says, then shrinks to the orb while Nova keeps
  listening, then goes. It never takes focus from the app you're in, and it stays out of screenshots and screen
  shares. Click it for the full window (Settings included).
- **It opens at login and runs the daemon** - or uses one that's already running, such as `npm run dev` in a
  terminal. While you work on Nova itself, set Settings → Menu bar → *Who runs Nova's daemon* to the terminal. Its
  daemon writes to `~/.nova/logs/daemon.log`; the app's own log is
  `log show --predicate 'subsystem == "dev.nova.app"'`.

While Nova.app runs, a browser window of Nova shows what happens but doesn't listen or speak itself. The first time,
macOS asks whether Nova may use the microphone. Nova.app is signed on your Mac, so after a rebuild macOS may ask
again; to keep the permission across rebuilds, put a signing identity of yours in `.env`, for example
`NOVA_SIGN_IDENTITY="Apple Development: you@example.com (TEAMID)"` (`security find-identity -v -p codesigning`
lists yours). `apps/desktop/macos/.build/release/Nova --selftest` checks the parts that need no microphone.

## Reminders, briefings and routines

Nova speaks up by itself now - at the right moment:

- **Reminders**: "remind me to call mum at 5", "remind me tomorrow morning about the dentist", "every weekday at 9
  remind me to stand up", "in 20 minutes remind me to check the oven". They're kept in `~/.nova/reminders.json`, so
  they outlast a restart (one due while Nova was off comes up late, and says so). When one comes up: "snooze" (or
  "remind me again in an hour"), "mark it done". Ask "what are my reminders today?", or "cancel the reminder to call
  mum" (Nova checks which first). Times are read in code - "at 9" in the afternoon means 9 PM, "at 1" means 1 PM.
- **The Reminders app**: say "in my Reminders" - or choose *every reminder* in Settings - and it goes there too, so it
  reaches your iPhone ("add milk to my Reminders" works without a time). Nova speaks the app's own reminders when
  they're due as well. This goes through Nova.app, which asks for access to Reminders the first time.
- **When you're free**: reminders, finished agent tasks and the briefing always show in the orb and as a notification
  (with Snooze and Done). Nova says them only when it's a good moment: not while a camera is on or your calendar
  says you're in a meeting, not in the middle of answering you - and while you're away (the Mac locked, or no typing
  or clicking for 10 minutes) it waits, then tells you "while you were away…" when you're back. Ask "what did I miss?"
  any time. Settings → Reminders & routines can make it never speak unasked, or always.
- **The morning briefing**: the first time you unlock the Mac each morning (or at a time you set, or only when you
  say "brief me" or "good morning"): the day, the weather, what's on your calendar, today's reminders, and what the
  agents did overnight. The weather comes from [Open-Meteo](https://open-meteo.com) (free, no key; only the town you
  set leaves the Mac), the calendar through Nova.app. With a brain paired, it also looks in the services you've
  connected (Linear, GitHub, Notion…) for anything that needs you today.
- **Routines**: "when I say start work, open Slack and brief me", "every weekday at 9, open Linear and brief me" - by
  voice or in Settings → Reminders & routines. Each step is something you'd say; one that needs a yes still asks, and
  the routine carries on after. Routines live in the settings file (`routines`).
- **Agents report back**: every task you give an agent is on the task board (the ✳︎ in the dock, ⌘U) - what it's doing
  now, what it said when it finished, why it failed - with Stop and Run again; kept in `~/.nova/tasks.json`. Ask "what
  are the agents doing?" or "what did Claude say?". Results are told at a good moment, like everything above.
- **The current project**: say "I'm working on the website", or just work in it - Nova notices the project in the
  window you're in - and "ask Claude to fix the tests" goes there without "which project?". Nova still asks before an
  agent starts.

## Trust: undo, "yes, always", the record, privacy

Nova asks before anything risky - and now it can take things back, remember what you let it do, and show you
everything it did:

- **Undo**: "undo that" (or the Undo in the Activity panel, ⌘J) takes back the last thing Nova did: a reminder or
  timer, something it remembered or forgot, a routine, an app it opened (it quits again) or quit (it opens again), the
  project you were on. "Undo what Claude did" takes back that agent's last action. Something from more than an hour
  ago is asked about first.
- **Agents' changes, undone**: before an agent works in a git project, Nova snapshots the project's files - as a git
  tree, with its own index, so your staging, branches and history are never touched (kept under
  `refs/nova/snapshots`). "Undo that" after "Claude finished in Agentic_OS" puts back exactly the files Claude
  changed - created files go, deleted ones come back - after asking. If you've edited any of those files since, it
  refuses rather than overwrite your work. Projects that aren't git repositories can't be undone this way (Settings →
  Setup says which). Turn it off in Settings → Privacy & trust.
- **"Yes, always"**: answer one of Nova's questions with "yes, always" (or "yes, for today") and it remembers exactly
  that one thing - quitting Spotify, Claude running `npm test` in Agentic_OS, a service's one tool - and won't ask
  about it again. Never for deleting things or risky commands (`rm`, `sudo`, force-pushes, piping a download into a
  shell). Only ever from your own words; each is listed in Settings → Privacy & trust to revoke, and kept in the
  settings file (`trust.rules`). Ask "what have I allowed you to do?".
- **The record of actions**: everything Nova did, who asked (you, a brain, an agent, a routine), the risk tier and how
  it went - one file a day in `~/.nova/activity` (readable only by you), kept a month by default. The Activity panel
  filters and searches it; ask "what did you do today?", "what did you do this week?", "what did Claude change?".
- **Stop everything**: say "stop everything" - or press ⌃⌥⌘. anywhere (Nova.app), or the ■ in the dock - and Nova
  stops the agents' tasks, withdraws its questions, stops speaking and mutes the microphone.
- **Privacy**: Settings → Privacy & trust lists everything that leaves the Mac and where it goes - the brain, each
  agent, each service, the weather - worked out from your settings as they are, with a switch for each; and what stays
  (hearing, the voice, Reflex, memories, the record).
- **Setting up**: the first time, a walkthrough goes through the name and voice, a hearing check, Reflex, the agents
  found on the Mac, projects, Nova.app and its permissions, what stays on the Mac, and things to try. Settings → Setup
  keeps the checklist - what's missing and the fix for each - and runs the walkthrough again.

## Memory

Nova remembers what you tell it to, and nothing it wasn't told:

- **Say it**: "remember that my standup is at 10", "don't forget I'm vegetarian", "keep in mind that I like short
  answers" - saved at once.
- **Or agree to it**: when a brain notices something worth keeping, Nova asks first ("Want me to remember that you're
  vegetarian?") and saves it only on a yes. Settings → Memory turns these suggestions off.
- **Ask for it**: "what do you remember about my car?", "do you remember when my dentist appointment is?". Related
  memories also go along with each question to whoever answers (Settings → Memory → *Use memories in answers*).
- **Forget it**: "forget that my standup is at 10" (Nova checks which memory you mean first), or edit and delete them
  in Settings → Memory, where every memory is listed.

Conversations are kept too, one file per day in `~/.nova/conversations`, so you can ask "what did I ask you
yesterday?" - for as long as you choose (a week to forever, 90 days by default), or clear them in Settings. Memories are
plain JSON in `~/.nova/memory.json`, which you can read and edit by hand. Both are readable by you alone and never leave
the Mac, except when related memories go with a question to the brain you chose.

## Seeing the screen

With each question, Nova tells the brain what you're working in - the app in front, its window, the browser page and any
text you've selected - so "what does this error mean?" needs no explaining. When you ask it to look ("look at my
screen", "what's wrong with this chart?"), it reads the window in front as text on the Mac with Apple's Vision, and
brains that can see get the screenshot too. It never looks unless you mention the screen or say yes when a brain asks.
When Nova's own window is in front, it tells the brain about the app you were in just before. Settings → Screen turns
each part off.

Seeing is done by **Nova Eyes** (`apps/daemon/native/eyes`), a small background app built and signed on your Mac the
first time it's needed, in `~/.nova/apps`. Being its own app, it gets macOS permissions by name - not the terminal Nova
runs in - and it answers only the Nova daemon that started it. To let it see:

1. Settings → Screen → **Allow** next to Accessibility (for window titles and selected text), then turn on **Nova Eyes**
   in System Settings → Privacy & Security → Accessibility.
2. **Allow** next to Screen Recording (for looking when asked), then turn on **Nova Eyes** under Privacy & Security →
   Screen Recording, and press **Restart Nova Eyes** (macOS applies it only after a restart).
3. The first time it reads a browser's address, macOS asks whether Nova Eyes may control that browser; say OK.

Worth knowing: what Nova Eyes may see, Nova can see - and, as with any assistant that sees your screen, a program running
under your account could ask Nova for it (or start Nova Eyes itself). Grant these permissions on a Mac where you trust
what runs, and turn them off in System Settings whenever you like.

## Hands: Nova uses the Mac

Nova does what you'd do on the Mac yourself - when you ask, or when a brain or agent needs it:

- **Settings**: "volume to 30", "turn it down a bit", "mute the sound", the brightness, dark mode, Wi-Fi, Bluetooth,
  Focus (Do Not Disturb), "lock the screen", "put the Mac to sleep" (asked first), "how's the battery?".
- **Media**: play, pause, next, previous, "what's playing?", or "play some jazz" from the Music library (or Spotify).
- **Windows**: "Safari on the left, Slack on the right", "maximize this", "move this to the other display", minimize,
  full screen, hide an app, "what's open?" - and layouts you save ("save this layout as work", then "work layout").
- **Files**: find them by name or kind ("the budget spreadsheet", "PDFs from last week"), recent ones, open one, show it
  in Finder, read or sum up what's in it, move it to a folder, rename it, or put it in the Trash - never deleted for
  good. Moving, renaming and trashing are asked about first, naming the file Nova found.
- **Clipboard**: "what did I copy?" (never what a password manager hides), "copy that" (the last answer), "copy the
  link" (the page in front).
- **Your Shortcuts**: "run my log water shortcut", with text if it takes some ("run translate with good morning"), and
  "what shortcuts do I have?". Asked first; one still running after a minute is stopped.
- **Clicking and typing**: your own commands for the app in front - "click send", "type see you at five", "press
  command s", "scroll down".
- **A whole task on the computer**: "use the computer to book a table", "fill in this form for me". The brain that
  answers looks at the screen and clicks, types and scrolls one step at a time. Nova asks before each step, with a
  frame around the button or field it means, or once when you say "go ahead with all of it" - for that task only,
  never remembered. It holds off while you're using the mouse or keyboard, stops after 60 steps and says what's
  left, and the window and the orb show while it's at work. "Stop everything" takes its hands off at once.

The same rules hold whoever asks. You, by voice; brains and agents, as tools, agents at work on a project task
included. Anything you didn't ask for yourself is asked about first, and so is anything hard to take back. "Undo
that" takes back the volume, the brightness and the other settings, windows moved, a file moved or trashed, or what
was on the clipboard.

Hands works through Nova Eyes (above). Clicking, typing and windows need its Accessibility permission, and looking
needs Screen Recording. The first time Nova controls Music or Spotify, macOS asks whether Nova (or the terminal it
runs in) may; say OK. Settings → Hands turns brains' use of the computer off, sets the step limit and how long a
shortcut may run, and lists your Shortcuts.

## Reflex: Nova's own decision model

System 1 - deciding what each thing you say means - runs on your Mac by default, in about a millisecond,
with no language model, no API key and nothing sent anywhere. Install its 31 MB model once:

```bash
npm run reflex:download       # or Settings → Decisions → Install
```

It asks the same typed questions Jev answers (a *choice* of intent, app, agent and project; a *yes/no* on whether you
were talking to Nova; *scores* when a question needs one), and answers them from data:

- **About 10,000 phrasings:** 1,700 written out (`packages/core/src/decision/reflex/phrases.ts`) and patterns that
  multiply into thousands more (`grammar.ts`) - spoken slips and fillers, indirect requests, British and Ghanaian
  phrasing, and plenty of background speech (TV, calls, talking to someone else) so it knows what to ignore.
- **Two ways of reading them:** a search for the closest examples, and a classifier trained on all of them that weighs
  how much each word says about each intent. Both run on a small static embedding model
  ([potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), MIT) in plain TypeScript. The classifier trains
  in the background in about a second the first time Nova starts, and is kept in `~/.nova/reflex-classifier.json`.
- **Apps, projects and agents** are matched in code, including speech-recognition slips ("fig ma", "x code", "spotfy").
  Named things are masked before reading the intent, so "pull up notes" reads as "pull up app".
- **Context counts:** after "Quit Spotify?", "sure" or "not right now" is a reply; "cancel" with nothing running means stop.
- **Honest confidence:** answers are probabilities. With an agent answering open questions, Reflex only acts on clear
  matches and hands anything doubtful to the agent, which can still use the skill as a tool; without one, unclear
  requests get "could you say that again?" instead of a wrong action.
- **It lets you finish:** browsers cut speech at every pause, so Nova joins the pieces and waits longer when you trail off
  mid-sentence ("in my current project I want to…").
- **It learns from you, and from the brain:** saying yes to a confirmation or answering "Which app?" teaches it what that
  request meant. And when Reflex isn't sure and hands something to the brain, and the brain does it with exactly one of
  Nova's skills, Reflex learns that phrasing too - the next time, it's instant. Skills that only look something up (the
  time) don't teach, since the brain may have built on them. What it learned is kept in `~/.nova/reflex-learned.json`;
  Settings shows how much, and can switch learning off or forget it.

`npm run reflex:eval` measures it on phrasings it never learned from (every test phrasing is held out of its training
data). With a brain to hand doubtful requests to (`REFLEX_CANTHINK=1`), on set E - 362 utterances written by a separate
agent that never saw Reflex's data, Hands' included - it picks the right intent 75% of the time (the keyword matcher:
43%; the closest-example search alone: 75%, but doing the wrong thing 11% of the time), does the wrong thing 4% of
the time, and hands 21% to the brain. Across all sets it tells background speech from speech meant for it 94% of the
time. On the older held-out set C: 93% right, 6% wrong. Sets A, B and D are for development; C and E stay held out -
never tune to them (`REFLEX_SHOW_HELDOUT=1` shows their misses). The model is downloaded from a pinned revision
and checked against its checksums; it lives in `~/.nova/models` (`NOVA_MODELS_DIR` in `.env` moves it).

## Turning on Jev (optional)

1. Vercel dashboard → AI Gateway → create an API key.
2. Put it in `.env` as `AI_GATEWAY_API_KEY=...`
3. `npm run jev:ping` - measures real Jev latency from your location (do this first).
4. Restart `npm run dev`. The menu bar shows `System 1: jev`.

If Jev errors or runs past its time limit, Nova falls back automatically (Settings → Decisions). With the key, a cloud
model such as `anthropic/claude-sonnet-5` can answer open questions (Settings → Answers). When the TypeSafe waitlist
clears, a direct TypeSafe engine is one more `EngineSlot`.

## Using a local model (LM Studio, Ollama, oMLX, mlx_lm, llama.cpp)

1. Load a model in your local server and start it (LM Studio: Developer tab or `lms server start`).
2. Settings → Answers: pick `<server>/<model id>` - e.g. `lmstudio/google/gemma-4-e4b`, `ollama/gemma3:4b` (it suggests
   the models your servers offer). Built-in servers: `lmstudio` (:1234), `ollama` (:11434), `omlx` (:9000), `mlx` (:8080),
   `llamacpp` (:8080). Add any other OpenAI-compatible server in Settings → Local models; if it needs a key, put it in `.env`
   as `NOVA_<NAME>_API_KEY`.
3. Decisions don't need a language model - Reflex handles them. If you want one anyway: Settings → Decisions →
   Language model, then pick the model (small, fast, non-thinking models work best). For a server that rejects
   JSON-schema replies, turn off its "JSON replies" in Settings → Local models.
4. The menu bar shows `System 2: <server>/...` right away - no Vercel key needed, and nothing leaves your Mac.

## Pairing agents (Claude Code, Codex, OpenCode, Gemini CLI, ...)

Nova pairs with every agent CLI it finds installed, each running as the vendor's own unmodified tool signed in
with your account (Claude Code on your Claude plan, Codex on your ChatGPT plan, ...). Nova never handles those
logins, and it strips API-key variables so they bill your plan. Then say:

- "Nova, ask Codex what a monad is" - a question for that agent (no tools; nothing saved).
- "Nova, ask Claude to fix the failing test in Agentic_OS" - a task. Nova confirms first ("It can edit files and run
  commands there"), the agent works in the background with a live card in the UI, and Nova announces the result.
  Claude's shell commands and web access are asked out loud: *"Claude wants to run npm test in Agentic_OS. Allow it?"*
  Codex works inside its workspace sandbox instead. "Stop the agent" cancels.
- Open questions ("who are you?", "what should I cook tonight?") go to your default paired agent automatically, or whoever
  you pick in Settings → Answers. Nova speaks the answer sentence by sentence as it's written. Claude stays running
  between questions (no start-up wait, and it remembers the conversation); agents that can't still answer, just from scratch.
- Whoever answers can **act through Nova's tools** - open and quit apps, set timers, tell the time, open settings, hand coding
  tasks to agents - over MCP, which Claude Code, Codex, OpenCode and your own agents (`"mcp": ["--mcp-config", "{mcpConfig}"]`)
  all take; local and cloud models get them as AI SDK tools. The rules don't change with who asks: risky tools are confirmed
  out loud, and the riskiest never run by voice. Requests with several steps ("open Notes and set a ten minute timer") go to
  the answering agent, which can use several tools.

Projects are the folders next to this repo (default: its parent, e.g. `~/dev`; pick another in Settings → Projects) plus
any you name there. Agents only ever work in those folders - a path never comes from speech.

| Settings → Agents | In `settings.json` |
|---|---|
| Which agents, in order; the first is the default | `agents.enabled`: `["claude", "codex"]` - absent means every installed one |
| Each agent's model, extra CLI arguments and CLI path | `agents.options.codex`: `{ "model": "gpt-5.5", "args": "--oss --local-provider lmstudio", "bin": "/opt/bin/codex" }` |
| Longest a task may run | `agents.taskTimeoutMinutes` (default 30) |
| Your own agent CLIs | `agents.custom` - or a `nova.agents.json` file, see `nova.agents.example.json` |
Claude tasks load the project's own Claude settings but not your user-level ones, so an API gateway configured there
can't reroute them off your plan.

## Tests

```bash
npm test          # core: wake word, skills, confirmation flow, Jev (mocked), Reflex, turn-taking, integration rules;
                  # memory and screen rules; daemon: settings, Reflex with its model, integrations (local, hosted with
                  # sign-in, SSE), memory and conversation files, hearing with the real helper, Parakeet and Smart Turn
                  # when they're installed, Nova Eyes' text reading and Nova.app's self-test when they're built
npm run reflex:eval   # Reflex vs the keyword matcher, with and without its classifier: accuracy, wrong actions, confidence, speed
npm run typecheck
```

## Adding a skill

Add an entry to `packages/core/src/skills/builtin.ts`: an `id`, example phrasings (they become Jev's
choice criteria), a risk `tier` (0 just do it · 1 announce · 2 spoken confirm · 3 on-screen tap only),
and `run()`. Keep arithmetic, dates and parsing in code - the decision model only makes judgments.
