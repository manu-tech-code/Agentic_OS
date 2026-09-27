import type { PresenceConfig, ServerEvent, ShellAction, ShellStatus } from '@nova/core';

/**
 * Nova's Mac app, as the daemon sees it. While it's connected it is Nova's ears and voice: it
 * streams the microphone and plays replies through one audio engine (so its echo cancellation
 * knows Nova's voice and never mistakes it for the user's), and windows only show what's going
 * on. It tells the daemon what macOS lets it do, and gets its settings from here.
 */
export class Presence<P> {
  private app: { peer: P; version: string } | null = null;
  /** What the app last said about itself. */
  status: ShellStatus | null = null;

  constructor(
    private readonly opts: {
      send(peer: P, event: ServerEvent): void;
      /** The app came or went: windows take over listening and speaking, or hand them back. */
      changed(app: boolean): void;
    },
  ) {}

  get connected() {
    return this.app !== null;
  }

  get version() {
    return this.app?.version ?? null;
  }

  isApp(peer: P) {
    return this.app !== null && this.app.peer === peer;
  }

  /** The app said hello on this connection. A newer connection replaces an older one (it restarted). */
  attach(peer: P, version: string, config: PresenceConfig) {
    const was = this.connected;
    this.app = { peer, version };
    this.opts.send(peer, { type: 'shell-config', presence: config });
    if (!was) this.opts.changed(true);
  }

  /** A connection closed: if it was the app's, Nova's ears and voice go back to the windows. */
  detach(peer: P) {
    if (!this.isApp(peer)) return false;
    this.app = null;
    this.status = null;
    this.opts.changed(false);
    return true;
  }

  /** The app's report on itself. Anyone else's is ignored. */
  report(peer: P, status: ShellStatus) {
    if (!this.isApp(peer)) return false;
    this.status = status;
    return true;
  }

  /** Settings changed: the app gets the new ones. */
  configure(config: PresenceConfig) {
    if (this.app) this.opts.send(this.app.peer, { type: 'shell-config', presence: config });
  }

  /** Something Settings asked the app to do - false when there's no app to do it. */
  action(action: ShellAction) {
    if (!this.app) return false;
    this.opts.send(this.app.peer, { type: 'shell-action', action });
    return true;
  }

  /** Something for the app alone; false when there's no app. */
  send(event: ServerEvent) {
    if (!this.app) return false;
    this.opts.send(this.app.peer, event);
    return true;
  }

  /** Who plays Nova's voice: the app while it's connected, else every window. */
  voice(peers: Iterable<P>): P[] {
    return this.app ? [this.app.peer] : [...peers];
  }

  /** Whether this connection may stream its microphone to Nova: anyone, unless the app hears for Nova. */
  mayListen(peer: P) {
    return !this.app || this.app.peer === peer;
  }
}
