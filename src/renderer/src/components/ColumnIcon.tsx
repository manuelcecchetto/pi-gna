import { Circle, CircleCheck, CircleDot, CircleDotDashed, type IconComponent } from "./icons";
import type { Column } from "../../../shared/board";

/** A Kanban column's mark: open, half done, ready for you, done. */
const COLUMN_STYLE: Record<Column, { icon: IconComponent; color: string }> = {
  todo: { icon: Circle, color: "text-faint" },
  in_progress: { icon: CircleDotDashed, color: "text-warn" },
  in_review: { icon: CircleDot, color: "text-accent" },
  done: { icon: CircleCheck, color: "text-ok" },
};

export function ColumnIcon({ column, size = 13 }: { column: Column; size?: number }) {
  const { icon: Icon, color } = COLUMN_STYLE[column];
  return <Icon size={size} className={`shrink-0 ${color}`} />;
}
