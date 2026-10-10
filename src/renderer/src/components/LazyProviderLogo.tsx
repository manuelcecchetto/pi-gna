// The composers' provider marks, loaded on first use: the logo table (lib/provider-logos.ts, about 40 KB) stays out
// of the startup bundle (startup-bundle.test.ts). `fallback` shows meanwhile; by default a blank of the same size.
import { lazy, type ReactNode, Suspense } from "react";

const Logo = lazy(() => import("./ProviderLogo").then((module) => ({ default: module.ProviderLogo })));

export function LazyProviderLogo({ id, size, fallback }: { id: string; size: number; fallback?: ReactNode }) {
  return (
    <Suspense fallback={fallback ?? <span className="shrink-0" style={{ width: size, height: size }} />}>
      <Logo id={id} name={id} size={size} />
    </Suspense>
  );
}
