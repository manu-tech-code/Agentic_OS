import type { LayoutWindow } from '@nova/core';
import type { Eyes } from '../screen/eyes.ts';

/** What Nova's hands use of Nova Eyes - a fake in tests. */
export type HandsEyes = Pick<
  Eyes,
  | 'context'
  | 'snapshot'
  | 'act'
  | 'idle'
  | 'highlight'
  | 'unhighlight'
  | 'windows'
  | 'setWindow'
  | 'app'
  | 'brightness'
  | 'bluetooth'
  | 'lock'
  | 'mediaKey'
  | 'clipboardRead'
  | 'clipboardWrite'
  | 'trash'
  | 'untrash'
  | 'pdfText'
>;

/** Settings → Hands, as in effect now. */
export interface HandsConfig {
  /** Brains may use the computer. */
  computerUse: boolean;
  /** Frame what's about to be clicked while the user is asked. */
  showTarget: boolean;
  /** Hold off while the user uses the mouse or keyboard. */
  pauseOnInput: boolean;
  /** Clicks, typing, keys and scrolls for one request. */
  maxSteps: number;
  shortcutTimeoutMs: number;
  player: 'auto' | 'Music' | 'Spotify';
  layouts: Record<string, LayoutWindow[]>;
}
