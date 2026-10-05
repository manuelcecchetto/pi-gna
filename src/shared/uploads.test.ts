import { describe, expect, it } from "vitest";
import { isUploadId, sanitizeUploadName } from "./uploads";

describe("sanitizeUploadName", () => {
  it("keeps one path component and drops separators, traversal and control characters", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeUploadName("a/b\\c.txt")).toBe("a_b_c.txt");
    expect(sanitizeUploadName("..")).toBe("file");
    expect(sanitizeUploadName(".bashrc")).toBe("bashrc");
    expect(sanitizeUploadName("x\u0000y\n.png")).toBe("xy.png");
    expect(sanitizeUploadName("IMG 0001.jpg")).toBe("IMG 0001.jpg");
  });
  it("falls back for empty or non-string names and caps the length, keeping the extension", () => {
    expect(sanitizeUploadName("")).toBe("file");
    expect(sanitizeUploadName(null)).toBe("file");
    const long = sanitizeUploadName(`${"a".repeat(500)}.jpeg`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".jpeg")).toBe(true);
  });
});

describe("isUploadId", () => {
  it("accepts a uuid only", () => {
    expect(isUploadId("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUploadId("../123e4567-e89b-42d3-a456-426614174000")).toBe(false);
    expect(isUploadId(5)).toBe(false);
  });
});
