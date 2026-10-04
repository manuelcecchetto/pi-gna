import { join } from "node:path";
import { app } from "electron";

/** Files pi reads from disk. Packaged builds keep them beside app.asar, in app.asar.unpacked (electron-builder asarUnpack). */
export const onDisk = (...parts: string[]): string => join(app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked"), ...parts);
