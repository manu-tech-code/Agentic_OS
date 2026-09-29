/**
 * What Voice ID's two models hear: each needs the sound as it was trained on it. WeSpeaker takes Kaldi
 * filterbanks (as torchaudio's `kaldi.fbank` makes them, then less their mean); NVIDIA's TitaNet takes NeMo's
 * log-mel spectrogram, each band normalised. Both from 16 kHz 16-bit audio, 25 ms windows every 10 ms, 80 bands
 * - the arithmetic is here, in code.
 */

const RATE = 16_000;
const N_FFT = 512;
const BINS = N_FFT / 2 + 1;
const WINDOW = 400; // 25 ms
const HOP = 160; // 10 ms
export const MEL_BANDS = 80;

/** The smallest float32 step above 1: the floor under Kaldi's log energies. */
const FLOAT_EPS = 1.1920928955078125e-7;

/** In-place radix-2 FFT of 512 points. */
const fft = (() => {
  const levels = Math.log2(N_FFT);
  const reverse = new Uint16Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(N_FFT / 2);
  const sin = new Float64Array(N_FFT / 2);
  for (let i = 0; i < N_FFT / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N_FFT);
    sin[i] = -Math.sin((2 * Math.PI * i) / N_FFT);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 0; i < N_FFT; i++) {
      const j = reverse[i]!;
      if (j > i) {
        [re[i], re[j]] = [re[j]!, re[i]!];
        [im[i], im[j]] = [im[j]!, im[i]!];
      }
    }
    for (let size = 2; size <= N_FFT; size *= 2) {
      const half = size / 2;
      const step = N_FFT / size;
      for (let start = 0; start < N_FFT; start += size) {
        for (let k = 0; k < half; k++) {
          const c = cos[k * step]!;
          const s = sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * c - im[b]! * s;
          const ti = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  };
})();

/** A filterbank as sparse rows: where each band starts among the FFT bins, and its weights from there. */
type Bank = { start: number; weights: Float64Array }[];

function sparse(rows: Float64Array[]): Bank {
  return rows.map((row) => {
    let start = row.findIndex((w) => w > 0);
    if (start < 0) start = 0;
    let end = row.length;
    while (end > start && !(row[end - 1]! > 0)) end--;
    return { start, weights: row.slice(start, end) };
  });
}

/** Kaldi's mel scale and bands (torchaudio `get_mel_banks`: 20 Hz to Nyquist, triangles on the mel scale, none at Nyquist). */
const kaldiBank: Bank = (() => {
  const mel = (f: number) => 1127 * Math.log(1 + f / 700);
  const low = mel(20);
  const high = mel(RATE / 2);
  const delta = (high - low) / (MEL_BANDS + 1);
  const binWidth = RATE / N_FFT;
  const rows: Float64Array[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const left = low + b * delta;
    const centre = low + (b + 1) * delta;
    const right = low + (b + 2) * delta;
    const row = new Float64Array(BINS); // the last (Nyquist) bin stays 0
    for (let k = 0; k < BINS - 1; k++) {
      const m = mel(binWidth * k);
      row[k] = Math.max(0, Math.min((m - left) / (centre - left), (right - m) / (right - centre)));
    }
    rows.push(row);
  }
  return sparse(rows);
})();

/** librosa's Slaney mel scale and area-normalised bands (`librosa.filters.mel(sr=16000, n_fft=512, n_mels=80)`), as NeMo builds them. */
const slaneyBank: Bank = (() => {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  const toMel = (f: number) => (f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logStep : f / fSp);
  const toHz = (m: number) => (m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fSp * m);
  const top = toMel(RATE / 2);
  const points = Array.from({ length: MEL_BANDS + 2 }, (_, i) => toHz((top * i) / (MEL_BANDS + 1)));
  const freqs = Array.from({ length: BINS }, (_, k) => (k * RATE) / N_FFT);
  const rows: Float64Array[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const row = new Float64Array(BINS);
    const lowerWidth = points[b + 1]! - points[b]!;
    const upperWidth = points[b + 2]! - points[b + 1]!;
    const norm = 2 / (points[b + 2]! - points[b]!);
    for (let k = 0; k < BINS; k++) {
      const lower = (freqs[k]! - points[b]!) / lowerWidth;
      const upper = (points[b + 2]! - freqs[k]!) / upperWidth;
      row[k] = Math.max(0, Math.min(lower, upper)) * norm;
    }
    rows.push(row);
  }
  return sparse(rows);
})();

const hamming = Float64Array.from({ length: WINDOW }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
/** NeMo's Hann window (not periodic), centred in the 512-point frame as torch.stft pads it. */
const hann512 = (() => {
  const w = new Float64Array(N_FFT);
  const offset = (N_FFT - WINDOW) / 2;
  for (let i = 0; i < WINDOW; i++) w[offset + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  return w;
})();

function applyBank(bank: Bank, re: Float64Array, im: Float64Array, out: (band: number, energy: number) => void) {
  for (let b = 0; b < bank.length; b++) {
    const { start, weights } = bank[b]!;
    let e = 0;
    for (let k = 0; k < weights.length; k++) {
      const i = start + k;
      e += (re[i]! * re[i]! + im[i]! * im[i]!) * weights[k]!;
    }
    out(b, e);
  }
}

/**
 * WeSpeaker's input: Kaldi filterbanks of the 16-bit samples as they are (`kaldi.fbank(wave * 32768,
 * num_mel_bins=80, window_type='hamming', dither=0)`: frames within the audio only, each less its DC offset,
 * pre-emphasised by 0.97, windowed, power spectrum, log of each band's energy), then each band less its mean
 * over the turn. Row-major [frames × 80]; no frames when there's under 25 ms.
 */
export function kaldiFbank(samples: Int16Array): { feats: Float32Array; frames: number } {
  const frames = samples.length < WINDOW ? 0 : 1 + Math.floor((samples.length - WINDOW) / HOP);
  const feats = new Float32Array(frames * MEL_BANDS);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const frame = new Float64Array(WINDOW);
  for (let t = 0; t < frames; t++) {
    const offset = t * HOP;
    let mean = 0;
    for (let i = 0; i < WINDOW; i++) mean += samples[offset + i]!;
    mean /= WINDOW;
    for (let i = 0; i < WINDOW; i++) frame[i] = samples[offset + i]! - mean;
    // Pre-emphasis, the first sample against itself (Kaldi's replicate padding).
    for (let i = WINDOW - 1; i > 0; i--) frame[i] = frame[i]! - 0.97 * frame[i - 1]!;
    frame[0] = frame[0]! - 0.97 * frame[0]!;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < WINDOW; i++) re[i] = frame[i]! * hamming[i]!;
    fft(re, im);
    applyBank(kaldiBank, re, im, (b, e) => (feats[t * MEL_BANDS + b] = Math.log(Math.max(e, FLOAT_EPS))));
  }
  for (let b = 0; b < MEL_BANDS && frames > 0; b++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += feats[t * MEL_BANDS + b]!;
    mean /= frames;
    for (let t = 0; t < frames; t++) feats[t * MEL_BANDS + b] = feats[t * MEL_BANDS + b]! - mean;
  }
  return { feats, frames };
}

/**
 * TitaNet's input, as NeMo's `AudioToMelSpectrogramPreprocessor` makes it (TitaNet-Large's settings): the audio as
 * -1…1, pre-emphasised by 0.97, a centred STFT (512 points, zero padded), power, Slaney mel bands, log with a guard of
 * 2⁻²⁴, then each band normalised over the turn's frames (mean 0, unbiased standard deviation 1, + 1e-5). Frames
 * past the turn are 0, and the frames are padded to a multiple of 16. Row-major [80 × padded]; `frames` are the
 * turn's own.
 */
export function nemoMel(samples: Int16Array): { feats: Float32Array; frames: number; padded: number } {
  const n = samples.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = samples[i]! / 32768;
  for (let i = n - 1; i > 0; i--) x[i] = x[i]! - 0.97 * x[i - 1]!;
  const total = 1 + Math.floor(n / HOP);
  const frames = Math.floor(n / HOP);
  const padded = Math.ceil(total / 16) * 16;
  const feats = new Float32Array(MEL_BANDS * padded);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const logMel = new Float64Array(MEL_BANDS * frames);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - N_FFT / 2;
    for (let j = 0; j < N_FFT; j++) {
      const i = start + j;
      re[j] = i >= 0 && i < n ? x[i]! * hann512[j]! : 0;
      im[j] = 0;
    }
    fft(re, im);
    applyBank(slaneyBank, re, im, (b, e) => (logMel[b * frames + t] = Math.log(e + 2 ** -24)));
  }
  for (let b = 0; b < MEL_BANDS; b++) {
    const row = logMel.subarray(b * frames, (b + 1) * frames);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= frames || 1;
    let sq = 0;
    for (const v of row) sq += (v - mean) ** 2;
    const std = (frames > 1 ? Math.sqrt(sq / (frames - 1)) : 0) + 1e-5;
    for (let t = 0; t < frames; t++) feats[b * padded + t] = (row[t]! - mean) / std;
  }
  return { feats, frames, padded };
}
