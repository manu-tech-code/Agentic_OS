import type { HandsService } from '@nova/core';
import { osascript, type Run } from './run.ts';
import type { HandsEyes } from './types.ts';

/**
 * Music and Spotify, through their own AppleScript: which one is playing, what, and play, pause,
 * skip. "Play some jazz" searches the Music library. Anything else playing (a video, a podcast)
 * gets the keyboard's media keys, through Nova Eyes.
 */

export type Player = 'Music' | 'Spotify';
const PLAYERS: Player[] = ['Music', 'Spotify'];

const VERBS: Record<'play' | 'pause' | 'toggle' | 'next' | 'previous', string> = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', previous: 'previous track' };

/** What's playing, in a player: its state, then the track's name, artist and album - one per line. */
export const NOW_PLAYING = (app: Player) => [
  `tell application "${app}"`,
  'try',
  'set s to player state as text',
  'on error',
  'return "stopped"',
  'end try',
  'if s is "stopped" then return s',
  'try',
  'set t to current track',
  'return s & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t)',
  'on error',
  'return s',
  'end try',
  'end tell',
];

/**
 * Play something from the Music library - a playlist of that name, an artist, an album, a genre, or
 * whatever a search finds. Several tracks go into Nova's own playlist ("Played by Nova"), played in
 * order. The query arrives as an argument, never as part of the script.
 */
export const PLAY_QUERY = [
  'on run argv',
  'set q to item 1 of argv',
  'tell application "Music"',
  'set named to (every user playlist whose name is q)',
  'if named is not {} then',
  'play item 1 of named',
  'return "playlist" & tab & (name of item 1 of named)',
  'end if',
  'set lib to library playlist 1',
  'set kind to "artist"',
  'set hits to (every track of lib whose artist is q)',
  'if hits is {} then',
  'set kind to "album"',
  'set hits to (every track of lib whose album is q)',
  'end if',
  'if hits is {} then',
  'set kind to "genre"',
  'set hits to (every track of lib whose genre is q)',
  'end if',
  'if hits is {} then',
  'set kind to "search"',
  'set hits to (search lib for q)',
  'end if',
  'if hits is {} then return ""',
  'set first to item 1 of hits',
  'if kind is "artist" then set label to artist of first',
  'if kind is "album" then set label to (album of first) & " by " & (artist of first)',
  'if kind is "genre" then set label to genre of first',
  'if kind is "search" then set label to (name of first) & " by " & (artist of first)',
  'if (count of hits) is 1 then',
  'play first',
  'return "track" & tab & (name of first) & " by " & (artist of first)',
  'end if',
  'if not (exists user playlist "Played by Nova") then make new user playlist with properties {name:"Played by Nova"}',
  'set p to user playlist "Played by Nova"',
  'delete every track of p',
  'set n to count of hits',
  'if n > 100 then set n to 100',
  'repeat with i from 1 to n',
  'duplicate (item i of hits) to p',
  'end repeat',
  'play p',
  'return kind & tab & label',
  'end tell',
  'end run',
];

/** What PLAY_QUERY answered, as said: "your Running playlist", "Taylor Swift", "Abbey Road by The Beatles". */
export function playedSaid(out: string): string | null {
  const [kind, what] = out.trim().split('\t');
  if (!kind || !what) return null;
  if (kind === 'playlist') return `your ${what} playlist`;
  if (kind === 'genre') return `some ${what.toLowerCase()}`;
  return what;
}

/** "playing\nSong\nArtist\nAlbum" */
export function parseNowPlaying(app: Player, out: string) {
  const [state, title, artist, album] = out.split('\n').map((l) => l.trim());
  if (!state || state === 'stopped' || !title) return null;
  return { app, title, playing: state === 'playing', ...(artist ? { artist } : {}), ...(album ? { album } : {}) };
}

export interface MediaOptions {
  run: Run;
  eyes: HandsEyes | null;
  player: () => 'auto' | Player;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export function mediaHands(o: MediaOptions): HandsService['media'] {
  const log = o.log ?? ((line: string) => console.log(line));
  /** Trying Nova out (NOVA_DRY_RUN=1): say what would happen, and answer as if it had. */
  const pretend = <T>(what: string, answer: T): T => (log(`  [dry-run] ${what}`), answer);
  /** Running - asked without starting it. */
  const running = (app: Player) => o.run('pgrep', ['-x', app], { timeoutMs: 3000 }).then(() => true, () => false);
  const state = async (app: Player) => ((await osascript(o.run, NOW_PLAYING(app)).catch(() => 'stopped')).split('\n')[0] ?? 'stopped').trim();

  /** The player a command is for: the one named, the one playing, the one open - else, to play, the chosen one. */
  async function pick(named: Player | undefined, starting: boolean): Promise<Player | null> {
    if (named) return named;
    const open = (await Promise.all(PLAYERS.map(async (p) => ((await running(p)) ? p : null)))).filter((p): p is Player => p !== null);
    const chosen = o.player();
    for (const p of open) if ((await state(p)) === 'playing') return p;
    if (chosen !== 'auto' && (open.includes(chosen) || starting)) return chosen;
    if (open.length) return open.includes('Spotify') && !open.includes('Music') ? 'Spotify' : open[0]!;
    return starting ? (chosen === 'auto' ? 'Music' : chosen) : null;
  }

  return {
    async command(action, app) {
      const target = await pick(app, action === 'play');
      if (!target) {
        // Neither player is open: the media keys reach whatever else plays (a video, a podcast) - but never start something to pause it.
        if (action === 'pause' || !o.eyes) return { app: null };
        if (o.dryRun) return pretend(`media key ${action}`, { app: 'media' });
        await o.eyes.mediaKey(action === 'next' ? 'next' : action === 'previous' ? 'previous' : 'play');
        return { app: 'media' };
      }
      if (o.dryRun) return pretend(`tell ${target} to ${VERBS[action]}`, { app: target });
      try {
        await osascript(o.run, [`tell application "${target}" to ${VERBS[action]}`]);
      } catch (e) {
        // Not allowed to control it (macOS asks once), or it didn't answer: the media keys still work.
        if (!o.eyes || action === 'pause' || action === 'play') throw new Error(`${target} didn't answer: ${(e as Error).message}`);
        await o.eyes.mediaKey(action === 'next' ? 'next' : action === 'previous' ? 'previous' : 'play');
      }
      return { app: target };
    },

    async nowPlaying() {
      const found = [];
      for (const app of PLAYERS) {
        if (!(await running(app))) continue;
        const now = parseNowPlaying(app, await osascript(o.run, NOW_PLAYING(app)).catch(() => ''));
        if (now) found.push(now);
      }
      return found.find((n) => n.playing) ?? found[0] ?? null;
    },

    async play(query, app) {
      const target = app ?? (o.player() === 'Spotify' ? 'Spotify' : 'Music');
      // Spotify's AppleScript plays only what it has open - it can't search.
      if (target === 'Spotify') return null;
      if (o.dryRun) return pretend(`play "${query}" from the Music library`, { app: 'Music', what: query });
      const out = await osascript(o.run, PLAY_QUERY, [query], 45_000);
      const what = playedSaid(out);
      return what ? { app: 'Music', what } : null;
    },
  };
}
