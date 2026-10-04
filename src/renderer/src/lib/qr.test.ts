import { describe, expect, it } from "vitest";
import { qrCode } from "./qr";

describe("qrCode", () => {
  it("encodes a URL into a square of modules", () => {
    const { size, path } = qrCode("https://mac.tail1.ts.net/#pair=ABCD2345");
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0); // QR versions are 21, 25, 29, ...
    expect(path.startsWith("M")).toBe(true);
    // The finder pattern's corner is always dark.
    expect(path).toContain("M0 0h1v1h-1z");
  });

  it("is deterministic and differs by content", () => {
    expect(qrCode("a").path).toBe(qrCode("a").path);
    expect(qrCode("a").path).not.toBe(qrCode("b").path);
  });
});
