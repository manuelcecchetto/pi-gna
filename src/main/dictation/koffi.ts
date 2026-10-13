// transcribe-cpp imports "koffi"; the build points that import here (electron.vite.config.ts), so the dictation worker
// loads the Koffi addon dictation downloaded (assets.ts) instead of one from node_modules, which the app does not ship.
// The addon itself exports Koffi's whole API; the npm package's JS around it adds only deprecated aliases.
import { createRequire } from "node:module";

const addon = process.env.PIGNA_KOFFI;
if (!addon) throw new Error("PIGNA_KOFFI is not set");

const koffi = createRequire(import.meta.url)(addon);
export default koffi;
