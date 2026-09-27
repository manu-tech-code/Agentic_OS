import { createHash } from 'node:crypto';
import type { TrustService } from '@nova/core';

/** A remembered permission, as Settings keeps it (trust.rules.<id>). */
export interface Rule {
  key: string;
  label: string;
  /** The last day it holds (YYYY-MM-DD); none for good. */
  until?: string;
}

const today = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** A rule's id in Settings: keys hold dots and colons ("agent:claude:site:Bash:npm test"), ids don't. */
export const ruleId = (key: string) => `r${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

/**
 * What the user said "yes, always" (or "yes, for today") to - each exactly one thing: quitting
 * Spotify, Claude running `npm test` in one project, Linear creating issues. Only ever from the
 * user's own words (or their own hand in Settings); revoked in Settings → Privacy & trust.
 */
export class TrustRules implements TrustService {
  private byKey = new Map<string, Rule & { id: string }>();

  constructor(
    private readonly opts: {
      /** What Settings hold, by id. */
      rules: () => Record<string, Rule>;
      save: (changes: Record<string, unknown>) => Promise<void>;
      now?: () => Date;
    },
  ) {
    this.configure();
  }

  /** Settings changed. */
  configure() {
    this.byKey = new Map(
      Object.entries(this.opts.rules() ?? {})
        .filter(([, r]) => typeof r?.key === 'string' && typeof r.label === 'string')
        .map(([id, r]) => [r.key, { id, key: r.key, label: r.label, ...(r.until ? { until: r.until } : {}) }]),
    );
  }

  allows(key: string) {
    const rule = this.byKey.get(key);
    return Boolean(rule && (!rule.until || rule.until >= this.today()));
  }

  async allow(key: string, label: string, until?: string) {
    const id = ruleId(key);
    const rule = { key, label, ...(until ? { until } : {}) };
    this.byKey.set(key, { id, ...rule }); // holds at once, while Settings saves it
    await this.opts.save({ [`trust.rules.${id}`]: rule });
  }

  list() {
    return this.snapshot().map(({ key, label, until }) => ({ key, label, ...(until ? { until } : {}) }));
  }

  /** The ones in force, for Settings. */
  snapshot() {
    return [...this.byKey.values()].filter((r) => !r.until || r.until >= this.today()).sort((a, b) => a.label.localeCompare(b.label));
  }

  /** "For today" ones from before today are taken out of Settings. */
  async prune() {
    const gone = [...this.byKey.values()].filter((r) => r.until && r.until < this.today());
    if (gone.length) await this.opts.save(Object.fromEntries(gone.map((r) => [`trust.rules.${r.id}`, null])));
  }

  private today() {
    return today(this.opts.now?.() ?? new Date());
  }
}
