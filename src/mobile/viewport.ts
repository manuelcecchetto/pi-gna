// The phone's viewport on iOS: the app is exactly as tall as the visible area (so the keyboard pushes the composer up
// instead of iOS scrolling the whole page and the header away), and corners can follow the display's. REMOTE_IOS.md
// rows 15 and 16.

/** Display corner radius in pt by portrait screen size, as UIScreen reports it (kylebshr/ScreenCorners); 0 = square. */
const CORNERS: ReadonlyArray<readonly [width: number, height: number, radius: number]> = [
  [402, 874, 62], // 16 Pro, 17, 17 Pro
  [440, 956, 62], // 16 Pro Max, 17 Pro Max
  [420, 912, 62], // Air
  [393, 852, 55], // 14 Pro, 15, 15 Pro, 16
  [430, 932, 55], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [390, 844, 47.33], // 12, 12 Pro, 13, 13 Pro, 14, 16e
  [428, 926, 53.33], // 12 Pro Max, 13 Pro Max, 14 Plus
  [375, 812, 39], // X, Xs, 11 Pro, 12/13 mini (44, the smaller value errs safe)
  [414, 896, 39], // Xs Max, 11 Pro Max, Xr/11 (41.5)
];

export function displayCornerRadius(width: number, height: number): number {
  const [w, h] = width < height ? [width, height] : [height, width];
  return CORNERS.find(([cw, ch]) => cw === w && ch === h)?.[2] ?? 0;
}

export function isIos(userAgent: string, platform: string, touchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && touchPoints > 1);
}

/** The software keyboard is up: the visible area is well short of the full height (the tallest seen at this width). */
export function keyboardOpen(fullHeight: number, visibleHeight: number): boolean {
  return fullHeight - visibleHeight > 120;
}

export function installViewport(): void {
  const root = document.documentElement;
  if (!isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) return;
  root.classList.add("ios");
  const radius = displayCornerRadius(screen.width, screen.height);
  root.style.setProperty("--device-radius", `${radius}px`);
  root.classList.toggle("screen-corners", radius > 0);

  const viewport = window.visualViewport;
  if (!viewport) return;
  // iOS pans the page to show a focused field even though nothing overflows; the layout already fits above the keyboard.
  const pin = () => {
    if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0);
  };
  // iOS shrinks window.innerHeight with the keyboard as well, so the full height is the tallest seen per width
  // (a rotation changes the width and starts over).
  const full = new Map<number, number>();
  const sync = () => {
    const width = Math.round(viewport.width);
    const tallest = Math.max(full.get(width) ?? 0, viewport.height);
    full.set(width, tallest);
    root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    root.classList.toggle("keyboard", keyboardOpen(tallest, viewport.height));
    pin();
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", pin);
  // The pan lands over a few frames after focus moves.
  const settle = () => {
    for (const delay of [0, 50, 150, 300]) setTimeout(pin, delay);
  };
  window.addEventListener("focusin", settle);
  window.addEventListener("focusout", settle);
  sync();
}
