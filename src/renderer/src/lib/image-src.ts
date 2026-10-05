/** An image block's `src`: its bytes inline, or the host's URL for them on the phone (main/remote-images.ts). */
export const imageSrc = (image: { mimeType: string; data: string; url?: string }): string => image.url ?? `data:${image.mimeType};base64,${image.data}`;
