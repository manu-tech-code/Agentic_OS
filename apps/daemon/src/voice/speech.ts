/** Text and audio helpers shared by the daemon and the voice process. */

/** A reply in sentence-sized pieces, so speech starts after the first one instead of the whole reply. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) ?? [];
  const out: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    // Very short pieces ("Okay." "Hi!") ride along with the next one.
    if (out.length && out[out.length - 1]!.length < 24) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out;
}

/** 16-bit PCM in base64: half the size of floats, and plenty for speech. */
export function pcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}
