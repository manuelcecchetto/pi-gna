// Test fixture: WAV files for the dictation upload tests.

/** A WAV file: `fmt ` then `data`, with an optional chunk between them as some recorders write. */
export function wav(samples: number[], { tag = 1, bits = 16, rate = 16_000, channels = 1, extra = false, dataSize }: { tag?: number; bits?: number; rate?: number; channels?: number; extra?: boolean; dataSize?: number } = {}): Buffer {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => (bits === 16 ? data.writeInt16LE(v, i * 2) : data.writeFloatLE(v, i * 4)));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(tag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = extra ? Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "ascii")]) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write("data", 0, "ascii");
  head.writeUInt32LE(dataSize ?? data.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, list, head, data]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
