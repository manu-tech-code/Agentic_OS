import type { ServerEvent } from '@nova/core';
import { describe, expect, it } from 'vitest';
import { PHONE_THINK_MS, PHONE_VOICE_MS, VoicePlace } from '../src/voice/place.ts';

/** Nova's voice among two phones and the Mac's app, on a clock of its own. */
function setup() {
  const connected = new Set(['phone', 'other phone', 'app']);
  const sent: [string, string][] = [];
  let now = 1_000;
  const place = new VoicePlace<string>({
    peers: () => connected,
    connected: (peer) => connected.has(peer),
    isPhone: (peer) => peer.endsWith('phone'),
    mac: () => ['app'].filter((peer) => connected.has(peer)),
    send: (peer, event) => sent.push([peer, event.type === 'audio' ? `audio ${event.seq}` : event.type]),
    now: () => now,
  });
  return { place, connected, sent, wait: (ms: number) => (now += ms) };
}

const audio = (seq: number): ServerEvent => ({ type: 'audio', id: 'say-1', seq, sampleRate: 24_000, pcm: '', last: false });

describe('Nova speaks in one place at a time', () => {
  it('answers on the phone it was asked on, however long it thinks', () => {
    const { place, sent, wait } = setup();
    place.talkingOn('phone');
    wait(3 * 60_000);
    const reply = place.start();
    reply.say(audio(0));
    expect(reply.to).toBe('phone');
    expect(sent).toEqual([
      ['other phone', 'barge-in'],
      ['app', 'barge-in'],
      ['phone', 'audio 0'],
    ]);
  });

  it("says all of a reply where it started: a phone that goes halfway doesn't hand the rest to the Mac", () => {
    const { place, connected, sent } = setup();
    place.talkingOn('phone');
    const reply = place.start();
    reply.say(audio(0));
    connected.delete('phone');
    place.gone('phone');
    reply.say(audio(1));
    reply.say(audio(2));
    expect(reply.heard()).toBe(false);
    expect(sent.filter(([, what]) => what.startsWith('audio'))).toEqual([['phone', 'audio 0']]);
    expect(place.start().to).toBeNull(); // what's said next is said at the Mac
  });

  it('stops the phones when a reply starts at the Mac', () => {
    const { place, sent } = setup();
    place.talkingOn(null);
    const reply = place.start();
    reply.say(audio(0));
    expect(reply.to).toBeNull();
    expect(sent).toEqual([
      ['phone', 'barge-in'],
      ['other phone', 'barge-in'],
      ['app', 'audio 0'],
    ]);
  });

  it('keeps a long reply on its phone, and speaks at the Mac a while after Nova has answered', () => {
    const { place, wait } = setup();
    place.talkingOn('phone');
    place.rested();
    const reply = place.start();
    for (let seq = 0; seq < 12; seq++) {
      wait(15_000); // three minutes of speech
      reply.say(audio(seq));
    }
    expect(place.current).toBe('phone');
    place.rested();
    wait(PHONE_VOICE_MS - 1);
    expect(place.current).toBe('phone');
    wait(1);
    expect(place.current).toBeNull();
  });

  it('gives up on a phone after the longest an answer may take', () => {
    const { place, wait } = setup();
    place.talkingOn('phone');
    wait(PHONE_THINK_MS - 1);
    expect(place.current).toBe('phone');
    wait(1);
    expect(place.current).toBeNull();
  });

  it('comes back to the Mac when the user talks there, or the phone goes', () => {
    const { place, connected } = setup();
    place.talkingOn('phone');
    place.talkingOn(null);
    expect(place.current).toBeNull();
    place.talkingOn('phone');
    connected.delete('phone');
    expect(place.current).toBeNull();
  });
});
