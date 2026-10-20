// The audio a remote client uploads for dictation (`dictation.transcribeUpload`): a WAV file already in the model's
// format, 16 kHz mono, as 16-bit PCM or 32-bit float. The host decodes nothing else; the client records or resamples
// to it (Android's AudioRecord records 16 kHz mono PCM directly).
import { HostError } from "../../shared/host-api";
import { MAX_SAMPLES, SAMPLE_RATE } from "../../shared/dictation";

const PCM = 1;
const FLOAT = 3;

const bad = (message: string) => new HostError("bad_request", message);

/** The samples of a 16 kHz mono WAV as floats in -1..1; throws `bad_request` for any other file. */
export function decodeWav(file: Buffer): Float32Array {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw bad("the recording is not a WAV file");
  let format: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= file.length; ) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = file.subarray(at + 8, Math.min(file.length, at + 8 + size));
    if (id === "fmt " && body.length >= 16) format = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    // A recorder that streams may leave the data size at 0 or past the end: the samples are then the rest of the file.
    if (id === "data") data = size === 0 ? file.subarray(at + 8) : body;
    if (data) break;
    at += 8 + size + (size & 1);
  }
  if (!format || !data) throw bad("the WAV file has no audio");
  const pcm16 = format.tag === PCM && format.bits === 16;
  const float32 = format.tag === FLOAT && format.bits === 32;
  if (!(pcm16 || float32) || format.channels !== 1 || format.rate !== SAMPLE_RATE) throw bad("the recording must be 16 kHz mono WAV, 16-bit PCM or 32-bit float");
  const count = Math.floor(data.length / (pcm16 ? 2 : 4));
  if (!count) throw bad("the recording is empty");
  if (count > MAX_SAMPLES) throw new HostError("payload_too_large", "the recording is too long");
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = pcm16 ? data.readInt16LE(i * 2) / 32768 : data.readFloatLE(i * 4);
  return samples;
}
