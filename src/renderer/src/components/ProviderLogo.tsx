import { useId } from "react";
import { logoFor } from "../lib/login";

/** The provider's mark on its brand tile (src/renderer/src/lib/provider-logos.ts), or its initial. */
export function ProviderLogo({ id, name, size }: { id: string; name: string; size: number }) {
  const prefix = useId().replace(/[^\w-]/g, "");
  const logo = logoFor(id);
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.26) };
  if (!logo) {
    return (
      <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.45) }} className="flex shrink-0 items-center justify-center bg-raised font-semibold text-muted ring-1 ring-line ring-inset">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const mark = Math.round(size * logo.scale);
  return (
    <span aria-hidden="true" style={{ ...box, background: logo.background, color: logo.color }} className="flex shrink-0 items-center justify-center ring-1 ring-black/10 ring-inset dark:ring-white/10">
      {/* The markup is generated from vendored SVG files, never from input. */}
      <svg viewBox={logo.viewBox} width={mark} height={mark} dangerouslySetInnerHTML={{ __html: logo.body.replaceAll("{id}", prefix) }} />
    </span>
  );
}
