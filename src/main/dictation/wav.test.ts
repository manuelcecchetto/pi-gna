import { describe, expect, it } from "vitest";
import { HostError } from "../../shared/host-api";
import { MAX_SAMPLES } from "../../shared/dictation";
import { decodeWav } from "./wav";
import { wav } from "./wav.fixture";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof HostError ? error.code : "not a HostError";
  }
  return "no error";
};

describe("decodeWav", () => {
  it("reads 16-bit PCM as floats in -1..1, past chunks it does not know (odd sizes padded)", () => {
    expect(Array.from(decodeWav(wav([0, 16384, -32768], { extra: true })))).toEqual([0, 0.5, -1]);
  });

  it("reads 32-bit float as it is", () => {
    expect(Array.from(decodeWav(wav([0.25, -0.5], { tag: 3, bits: 32 })))).toEqual([0.25, -0.5]);
  });

  it("takes the rest of the file when a streaming recorder left the data size at 0", () => {
    expect(decodeWav(wav([1, 2, 3, 4], { dataSize: 0 })).length).toBe(4);
  });

  it("refuses anything but 16 kHz mono 16-bit PCM or 32-bit float", () => {
    expect(code(() => decodeWav(Buffer.from("not audio at all")))).toBe("bad_request");
    expect(code(() => decodeWav(wav([1], { rate: 48_000 })))).toBe("bad_request");
    expect(code(() => decodeWav(wav([1, 1], { channels: 2 })))).toBe("bad_request");
    expect(code(() => decodeWav(wav([1], { bits: 32 })))).toBe("bad_request");
    expect(code(() => decodeWav(wav([])))).toBe("bad_request");
  });

  it("refuses a recording longer than the model takes", () => {
    expect(code(() => decodeWav(wav(new Array(MAX_SAMPLES + 1).fill(0))))).toBe("payload_too_large");
  });
});
