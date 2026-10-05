import { Ansi } from "./primitives";

/** An extension's widget above or below the composer: lines of ANSI text. */
export function Widget({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
      {lines.map((line, index) => (
        <div key={index} className="whitespace-pre-wrap">
          <Ansi text={line} />
        </div>
      ))}
    </div>
  );
}
