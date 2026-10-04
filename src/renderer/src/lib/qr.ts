// The pairing QR: the encoder is the bundled MIT `qrcode-generator`; this turns its modules into one SVG path.
import qrcode from "qrcode-generator";

export interface QrCode {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** `M<x> <y>h1v1h-1z` for every dark module, in module units. */
  path: string;
}

/** Medium error correction, the smallest version that fits. */
export function qrCode(text: string): QrCode {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
  return { size, path };
}
