// Messages from main and pi mark commands, paths and packages with backticks, Markdown style. Error boxes show them
// as plain text, so this turns each `span` into code instead of printing the backticks.
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/).map((part, index) =>
        index % 2 ? (
          <code key={index} className="rounded-[5px] bg-raised px-[0.36em] py-[0.12em] font-mono text-[0.86em] wrap-anywhere">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
