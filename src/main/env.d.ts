// Build-time constants for main and the preload (electron.vite.config.ts).

/** This build's id; main hands it to the window, whose preload compares it with its own. */
declare const __PIGNA_BUILD__: string;
