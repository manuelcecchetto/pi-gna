// Markdown as the words a reader sees, for one-line snippets (card and lament rows, the phone's turn list, push
// previews): emphasis, code ticks, link targets and list markers go, their text stays. Not for anything rendered as
// Markdown; that goes through renderer/src/lib/markdown.ts.
import { Lexer, type Token, type Tokens } from "marked";

/** The text of a Markdown source on one line, whitespace collapsed. */
export function markdownText(markdown: string): string {
  return blocks(Lexer.lex(markdown)).replace(/\s+/g, " ").trim();
}

const blocks = (tokens: Token[]): string => tokens.map(text).join(" ");
const inline = (tokens: Token[]): string => tokens.map(text).join("");

function text(token: Token): string {
  switch (token.type) {
    case "space":
    case "hr":
    case "br":
    case "checkbox":
    case "html":
      return " ";
    case "list":
      return (token as Tokens.List).items.map((item) => blocks(item.tokens)).join(" ");
    case "table": {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows].flatMap((row) => row.map((cell) => inline(cell.tokens))).join(" ");
    }
    case "blockquote":
      return blocks((token as Tokens.Blockquote).tokens);
    case "paragraph":
    case "heading":
      return `${inline((token as Tokens.Paragraph).tokens)} `;
    default:
      // Inline containers (strong, em, del, link, text with children) hold their words in `tokens`; leaves (text,
      // codespan, code, escape, image alt) in `text`.
      return "tokens" in token && Array.isArray(token.tokens) && token.type !== "image" ? inline(token.tokens) : "text" in token ? String(token.text) : "";
  }
}
