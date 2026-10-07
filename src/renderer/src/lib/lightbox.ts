// The full-screen image viewer's state, shared by the desktop and the phone: the images it pages through (an answer's
// embedded images, a message's attachments) and the one on screen.
export interface LightboxView {
  images: string[];
  index: number;
}

/** The viewer on `src`, paging through `images` when it is one of them. */
export function lightboxAt(src: string, images: string[] = [src]): LightboxView {
  const index = images.indexOf(src);
  return index < 0 ? { images: [src], index: 0 } : { images, index };
}

/** The view `delta` images on; the ends stop it (no wrapping), returning the same view. */
export function lightboxStep(view: LightboxView, delta: number): LightboxView {
  const index = Math.min(view.images.length - 1, Math.max(0, view.index + delta));
  return index === view.index ? view : { ...view, index };
}
