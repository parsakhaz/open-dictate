// Minimal PCM WAV reader for fixtures: 16-bit or float32, any channel count (first channel used).
import fs from 'node:fs';

export function readWav(file: string): { sampleRate: number; samples: Float32Array } {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
  let o = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') {
      if (!fmt) throw new Error(`${file}: data before fmt`);
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = body + i * bytes * fmt.channels;
        out[i] = fmt.bits === 16 ? b.readInt16LE(p) / 32768 : b.readFloatLE(p);
      }
      return { sampleRate: fmt.sampleRate, samples: out };
    }
    o = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}
