// The Kanban board on disk (userData/board.json). Main owns it because agents change it too (through the
// bridge); the window gets the whole board after every change.
import { applyOp, type Board, type BoardOp, emptyBoard, parseBoard } from "../shared/board";
import { JsonStore } from "./store";

export class BoardStore extends JsonStore<Board, BoardOp> {
  constructor(file: string, changed: (board: Board) => void) {
    const parse = (raw: unknown) => {
      const { board, dropped } = parseBoard(raw);
      return { value: board, dropped };
    };
    super(file, { name: "board", item: "card", empty: emptyBoard, apply: applyOp, parse }, changed);
  }
}
