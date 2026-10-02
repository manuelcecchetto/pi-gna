import hand from "../assets/pigna-hand.svg";

/** The pi-gna wordmark, 🤌i-gna: the mirrored, turned 🤌 is the P (see docs/DESIGN.md, Brand). */
export function PignaMark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline ${className}`} role="img" aria-label="pi-gna">
      <img src={hand} alt="" draggable={false} className="mr-[0.5px] h-[1.02em] w-auto self-center" />
      <span aria-hidden>i-gna</span>
    </span>
  );
}
