import type { ReactNode, SVGProps } from "react";

/**
 * pi-gna's icon set (see docs/DESIGN.md, Icons): a 24px grid, 2px round strokes, soft 3-4px corners, few details.
 * Exports keep the lucide-react names the app grew up with, so `<Check size={12} />` reads the same; props pass
 * through to the <svg> (`fill="currentColor"` fills a Square or Play, `strokeWidth` thickens one).
 */
export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}
export type IconComponent = (props: IconProps) => ReactNode;

function icon(name: string, glyph: ReactNode): IconComponent {
  const Glyph = ({ size = 24, className, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={className ? `icon icon-${name} ${className}` : `icon icon-${name}`}
      {...props}
    >
      {glyph}
    </svg>
  );
  Glyph.displayName = name;
  return Glyph;
}

// Shared outlines.
const bubble = <path d="M3 8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-4.5 3v-3.2A4 4 0 0 1 3 14z" />;
const page = <path d="M14 3H8a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8zM14 3v3.5A1.5 1.5 0 0 0 15.5 8H19" />;
const tile = <rect x="3" y="3" width="18" height="18" rx="4" />;
const win = <rect x="3" y="4" width="18" height="16" rx="3.5" />;
const ring = <circle cx="12" cy="12" r="9" />;
const dashedRing = <circle cx="12" cy="12" r="9" strokeDasharray="2.5 4.57" />;
const triangle = <path d="M10.3 4.2a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z" />;
const shield = <path d="M12 3l7 2.8a1.5 1.5 0 0 1 1 1.4V12c0 4.6-3.4 8-8 9.5C7.4 20 4 16.6 4 12V7.2a1.5 1.5 0 0 1 1-1.4z" />;
const prNodes = (
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M6 8.5v7" />
  </>
);
const pointer = <path d="M5 4.5l14 5.5-6 2.5-2.5 6.5z" />;
const sparkle = <path d="M10 6q.9 6.1 7 7-6.1.9-7 7-.9-6.1-7-7 6.1-.9 7-7z" />;

// Marks and arrows.
export const X = icon("x", <path d="M6 6l12 12M18 6L6 18" />);
export const Check = icon("check", <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const Plus = icon("plus", <path d="M12 5v14M5 12h14" />);
export const Minus = icon("minus", <path d="M5 12h14" />);
export const ChevronDown = icon("chevron-down", <path d="M6 9l6 6 6-6" />);
export const ChevronLeft = icon("chevron-left", <path d="M15 6l-6 6 6 6" />);
export const ChevronRight = icon("chevron-right", <path d="M9 6l6 6-6 6" />);
export const ChevronsUpDown = icon("chevrons-up-down", <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />);
export const ArrowUp = icon("arrow-up", <path d="M12 20V4M6 10l6-6 6 6" />);
export const ArrowDown = icon("arrow-down", <path d="M12 4v16M6 14l6 6 6-6" />);
export const ArrowLeft = icon("arrow-left", <path d="M20 12H4M10 6l-6 6 6 6" />);
export const ArrowRight = icon("arrow-right", <path d="M4 12h16M14 6l6 6-6 6" />);
export const ArrowUpCircle = icon("arrow-up-circle", <>{ring}<path d="M12 16V8M8.5 11.5L12 8l3.5 3.5" /></>);
export const CornerDownRight = icon("corner-down-right", <path d="M4 4v7a4 4 0 0 0 4 4h12M15 10l5 5-5 5" />);
export const ExternalLink = icon(
  "external-link",
  <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3" />,
);
export const SquareArrowOutUpRight = icon(
  "square-arrow-out-up-right",
  <path d="M21 13v4a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h4M15 3h6v6M21 3l-9 9" />,
);
export const RotateCcw = icon("rotate-ccw", <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8" />);
export const RotateCw = icon("rotate-cw", <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5M20.5 4v4.5H16" />);
export const RefreshCw = icon(
  "refresh-cw",
  <path d="M4.5 10A8 8 0 0 1 19 8M19 3.5V8h-4.5M19.5 14A8 8 0 0 1 5 16M5 20.5V16h4.5" />,
);
export const Maximize = icon(
  "maximize",
  <path d="M8 3H6a3 3 0 0 0-3 3v2M21 8V6a3 3 0 0 0-3-3h-2M3 16v2a3 3 0 0 0 3 3h2M16 21h2a3 3 0 0 0 3-3v-2" />,
);
export const Maximize2 = icon("maximize-2", <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />);
export const Minimize2 = icon("minimize-2", <path d="M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M10 14l-6.5 6.5" />);
export const FoldVertical = icon(
  "fold-vertical",
  <path d="M12 3v5.5M9 5.5l3 3 3-3M12 21v-5.5M9 18.5l3-3 3 3M4 12h3M10.5 12h3M17 12h3" />,
);
export const GripVertical = icon(
  "grip-vertical",
  <>
    <circle cx="9" cy="5.5" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="18.5" r="1" />
    <circle cx="15" cy="5.5" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="18.5" r="1" />
  </>,
);
export const Ellipsis = icon(
  "ellipsis",
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
);
export const MoreHorizontal = Ellipsis;

// Circles: states and notices.
export const Circle = icon("circle", ring);
export const CircleDashed = icon("circle-dashed", dashedRing);
export const CircleDot = icon("circle-dot", <>{ring}<circle cx="12" cy="12" r="1.5" /></>);
export const CircleDotDashed = icon("circle-dot-dashed", <>{dashedRing}<circle cx="12" cy="12" r="1.5" /></>);
export const CircleCheck = icon("circle-check", <>{ring}<path d="M8.5 12.5l2.5 2.5 4.5-5" /></>);
export const CircleX = icon("circle-x", <>{ring}<path d="M9 9l6 6M15 9l-6 6" /></>);
export const CircleSlash = icon("circle-slash", <>{ring}<path d="M9 15l6-6" /></>);
export const CircleAlert = icon("circle-alert", <>{ring}<path d="M12 7.5v5M12 16.5h.01" /></>);
export const Info = icon("info", <>{ring}<path d="M12 11v5.5M12 7.5h.01" /></>);
export const Ban = icon("ban", <>{ring}<path d="M5.6 5.6l12.8 12.8" /></>);
export const TriangleAlert = icon("triangle-alert", <>{triangle}<path d="M12 9v4M12 16.5h.01" /></>);
export const AlertTriangle = TriangleAlert;
export const ShieldAlert = icon("shield-alert", <>{shield}<path d="M12 8.5v4M12 16h.01" /></>);
export const ShieldQuestion = icon(
  "shield-question",
  <>{shield}<path d="M10 9.8a2 2 0 1 1 2.8 1.8c-.5.2-.8.7-.8 1.2M12 16h.01" /></>,
);
export const LoaderCircle = icon("loader-circle", <path d="M12 3a9 9 0 1 0 9 9" />);
export const Loader2 = LoaderCircle;
export const Angry = icon("angry", <>{ring}<path d="M8.5 16.5a4.5 4.5 0 0 1 7 0M8 8.5l2.5 1.5M16 8.5l-2.5 1.5" /></>);

// Chat.
export const MessageSquare = icon("message-square", bubble);
export const MessageSquarePlus = icon("message-square-plus", <>{bubble}<path d="M12 8v6M9 11h6" /></>);
export const MessagesSquare = icon(
  "messages-square",
  <path d="M3 11a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H9.5L6 20.5v-2.6A3 3 0 0 1 3 15zM8 8V6a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-2" />,
);
export const MessageCircle = icon("message-circle", <path d="M7.9 20A9 9 0 1 0 4 16.1L2.5 21.5z" />);
export const MessageCircleOff = icon(
  "message-circle-off",
  <path d="M3 3l18 18M20.5 14.9A9 9 0 0 0 9.1 3.5M5.6 5.6A9 9 0 0 0 4 16.1L2.5 21.5 7.9 20a9 9 0 0 0 10.4-1.7" />,
);
export const Sparkles = icon(
  "sparkles",
  <>{sparkle}<path d="M18 2.5q.4 2.1 2.5 2.5-2.1.4-2.5 2.5-.4-2.1-2.5-2.5 2.1-.4 2.5-2.5z" /></>,
);
export const Zap = icon("zap", <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />);
export const Brain = icon(
  "brain",
  <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.1 1 1.9v.2h5v-.2c0-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z" />,
);
export const Bot = icon("bot", <><rect x="4" y="8" width="16" height="12" rx="4" /><path d="M12 4.5V8M9.5 13v1.5M14.5 13v1.5M2 13v2M22 13v2" /></>);
export const UserRound = icon("user-round", <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>);
export const Bookmark = icon("bookmark", <path d="M6 6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v14.5l-6-4-6 4z" />);
export const Star = icon(
  "star",
  <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z" />,
);
export const Paperclip = icon(
  "paperclip",
  <path d="M20.5 11.5l-8.3 8.3a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.85 1.85 0 0 1-2.6-2.6l7.9-7.9" />,
);
export const Play = icon(
  "play",
  <path d="M7 5.5v13a1.5 1.5 0 0 0 2.3 1.3l10-6.5a1.5 1.5 0 0 0 0-2.6l-10-6.5A1.5 1.5 0 0 0 7 5.5z" />,
);
export const Pause = icon("pause", <><rect x="6" y="4.5" width="4" height="15" rx="1.5" /><rect x="14" y="4.5" width="4" height="15" rx="1.5" /></>);
export const Square = icon("square", tile);

// Files and media.
export const File = icon("file", page);
export const FileText = icon("file-text", <>{page}<path d="M9 13h6M9 17h3.5" /></>);
export const FileCode = icon("file-code", <>{page}<path d="M10 12.5l-2 2 2 2M14 12.5l2 2-2 2" /></>);
export const FileImage = icon(
  "file-image",
  <>{page}<circle cx="10" cy="12" r="1.5" /><path d="M19 16.5l-1.4-1.4a1.5 1.5 0 0 0-2.1 0L10.5 20" /></>,
);
export const FileSpreadsheet = icon("file-spreadsheet", <>{page}<path d="M8.5 13h2M13.5 13h2M8.5 17h2M13.5 17h2" /></>);
export const FilePen = icon("file-pen", <>{page}<path d="M8.5 17.5l.5-2.5 4.5-4.5a1.4 1.4 0 0 1 2 2L11 17z" /></>);
export const FileWarning = icon("file-warning", <>{page}<path d="M12 11.5v3M12 17.5h.01" /></>);
export const Files = icon(
  "files",
  <path d="M8 7V6a3 3 0 0 1 3-3h4.5L20 7.5V15a3 3 0 0 1-3 3h-1M4 10a3 3 0 0 1 3-3h4.5l4.5 4.5V18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" />,
);
export const Folder = icon(
  "folder",
  <path d="M3 7a3 3 0 0 1 3-3h3a2 2 0 0 1 1.4.6L12 6h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM3 10h18" />,
);
export const FolderOpen = icon(
  "folder-open",
  <path d="M3 17V7a3 3 0 0 1 3-3h3a2 2 0 0 1 1.4.6L12 6h5a3 3 0 0 1 3 3v1.5M3 17l2.3-5.2a2 2 0 0 1 1.8-1.3H20a1.5 1.5 0 0 1 1.4 2l-2.2 6.1a2 2 0 0 1-1.9 1.4H6a3 3 0 0 1-3-3z" />,
);
export const Image = icon(
  "image",
  <>{tile}<circle cx="9" cy="9" r="2" /><path d="M21 15.5l-3.6-3.6a2 2 0 0 0-2.8 0L6.5 20" /></>,
);
export const ImageIcon = Image;
export const ImagePlus = icon(
  "image-plus",
  <>
    <path d="M21 12v5a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h5M16 5.5h6M19 2.5v6M21 15.5l-3.6-3.6a2 2 0 0 0-2.8 0L6.5 20" />
    <circle cx="9" cy="9" r="2" />
  </>,
);
export const Film = icon(
  "film",
  <>{tile}<path d="M7.5 3v18M16.5 3v18M3 12h18M3 7.5h4.5M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21" /></>,
);
export const Music = icon("music", <><path d="M9 18V5.5l11-2V16" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>);
export const Presentation = icon("presentation", <path d="M3 4h18M4.5 4v8a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V4M12 15v6M8.5 21h7" />);
export const BookOpen = icon("book-open", <path d="M12 7C10 5.5 7 5 3 5v13c4 0 7 .5 9 2 2-1.5 5-2 9-2V5c-4 0-7 .5-9 2zM12 7v13" />);
export const ClipboardCheck = icon(
  "clipboard-check",
  <>
    <rect x="8" y="2.5" width="8" height="4" rx="1.5" />
    <path d="M16 4.5h1a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3h1M9 14l2 2 4-4" />
  </>,
);

// Editing.
export const Copy = icon(
  "copy",
  <><rect x="8" y="8" width="13" height="13" rx="3" /><path d="M16 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2" /></>,
);
export const Pencil = icon("pencil", <path d="M17 3.5a2.1 2.1 0 0 1 3 3L7.5 19l-4 1 1-4zM14.5 6l3 3" />);
export const SquarePen = icon(
  "square-pen",
  <path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5M18.4 2.6a2.1 2.1 0 0 1 3 3l-8.9 8.9-3.5 1 1-3.5z" />,
);
export const Trash2 = icon(
  "trash",
  <path d="M4 6h16M9 6V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1M6 6l.8 12.2a3 3 0 0 0 3 2.8h4.4a3 3 0 0 0 3-2.8L18 6M10 11v5M14 11v5" />,
);
export const Pin = icon(
  "pin",
  <path d="M9 4h6M10 4v5c0 .8-.4 1.5-1 2l-1.6 1.3c-.6.5-.9 1.1-.9 1.9v.8h11v-.8c0-.8-.3-1.4-.9-1.9L15 11c-.6-.5-1-1.2-1-2V4M12 15v6" />,
);
export const PinOff = icon(
  "pin-off",
  <path d="M3 3l18 18M9 4h6M14 4v5c0 .8.4 1.5 1 2l1.6 1.3M10 4v1M9.3 10.6L9 11l-1.6 1.3c-.6.5-.9 1.1-.9 1.9v.8H15M12 15v6" />,
);
export const Link2 = icon("link", <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" />);
export const Unlink = icon("unlink", <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M12 3v2M12 19v2" />);
export const Search = icon("search", <><circle cx="11" cy="11" r="7" /><path d="M16 16l4.5 4.5" /></>);
export const ZoomOut = icon("zoom-out", <><circle cx="11" cy="11" r="7" /><path d="M16 16l4.5 4.5M8 11h6" /></>);
export const ScanSearch = icon(
  "scan-search",
  <>
    <path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2M14 14l2.5 2.5" />
    <circle cx="11.5" cy="11.5" r="3" />
  </>,
);
export const Eye = icon(
  "eye",
  <><path d="M2.5 12C4.5 7.5 8 5 12 5s7.5 2.5 9.5 7c-2 4.5-5.5 7-9.5 7s-7.5-2.5-9.5-7z" /><circle cx="12" cy="12" r="3" /></>,
);
export const EyeOff = icon(
  "eye-off",
  <path d="M3 3l18 18M10.6 5.1Q11.3 5 12 5c4 0 7.5 2.5 9.5 7a13 13 0 0 1-1.7 2.8M6.6 6.6C4.9 7.8 3.5 9.6 2.5 12c2 4.5 5.5 7 9.5 7a9.4 9.4 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
);

// Lists and layout.
export const ListTree = icon("list-tree", <path d="M21 6H8M21 12h-8M21 18h-8M3 6v4a2 2 0 0 0 2 2h3M3 10v6a2 2 0 0 0 2 2h3" />);
export const ListEnd = icon("list-end", <path d="M16 5H3M16 12H3M9 19H3M16 16l-3 3 3 3M21 5v12a2 2 0 0 1-2 2h-6" />);
export const ListChevronsDownUp = icon("list-chevrons-down-up", <path d="M3 5h8M3 12h8M3 19h8M15 5l3 3 3-3M15 19l3-3 3 3" />);
export const ListChevronsUpDown = icon("list-chevrons-up-down", <path d="M3 5h8M3 12h8M3 19h8M15 8l3-3 3 3M15 16l3 3 3-3" />);
export const Layers = icon("layers", <path d="M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" />);
export const LayoutGrid = icon(
  "layout-grid",
  <>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
  </>,
);
export const PanelLeftClose = icon("panel-left-close", <>{tile}<path d="M9 3v18M16 9.5L13.5 12l2.5 2.5" /></>);
export const PanelLeftOpen = icon("panel-left-open", <>{tile}<path d="M9 3v18M14 9.5l2.5 2.5-2.5 2.5" /></>);
export const PanelRight = icon("panel-right", <>{tile}<path d="M15 3v18" /></>);
export const PanelTop = icon("panel-top", <>{tile}<path d="M3 9h18" /></>);
export const SquareKanban = icon("square-kanban", <>{tile}<path d="M8 8v6M12 8v8.5M16 8v3" /></>);
export const AppWindow = icon("app-window", <>{win}<path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>);
export const SquareTerminal = icon("square-terminal", <>{win}<path d="M7.5 9.5l3 2.5-3 2.5M13 15h3.5" /></>);
export const Code = icon("code", <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />);
export const Code2 = icon("code-xml", <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />);

// Git.
export const GitBranch = icon(
  "git-branch",
  <><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 3.5v12M18 8.5v1a5 5 0 0 1-5 5H6" /></>,
);
export const GitMerge = icon(
  "git-merge",
  <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5V21M6 8.5a9.5 9.5 0 0 0 9.5 9.5" /></>,
);
export const GitPullRequest = icon("git-pull-request", <>{prNodes}<path d="M18 15.5V10a3 3 0 0 0-3-3h-4M13.5 4.5L11 7l2.5 2.5" /></>);
export const GitPullRequestDraft = icon("git-pull-request-draft", <>{prNodes}<path d="M18 15.5V14M18 10.5v-1M18 6v-.5" /></>);
export const GitPullRequestClosed = icon("git-pull-request-closed", <>{prNodes}<path d="M18 15.5V11M15.5 3.5l5 5M20.5 3.5l-5 5" /></>);

// Devices, system and settings.
export const Monitor = icon("monitor", <><rect x="2.5" y="3.5" width="19" height="13" rx="3" /><path d="M8 21h8M12 16.5V21" /></>);
export const MonitorSmartphone = icon(
  "monitor-smartphone",
  <>
    <path d="M18 8V7a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h7M7 20h5M9.5 16v4" />
    <rect x="15" y="11" width="7" height="10" rx="2" />
  </>,
);
export const Smartphone = icon("smartphone", <><rect x="6" y="2.5" width="12" height="19" rx="3" /><path d="M11 18h2" /></>);
export const Keyboard = icon(
  "keyboard",
  <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9.5h.01M10 9.5h.01M14 9.5h.01M18 9.5h.01M8 15h8" /></>,
);
export const MousePointer2 = icon("mouse-pointer", <>{pointer}<path d="M13.5 13.5l5 5" /></>);
export const MousePointerClick = icon(
  "mouse-pointer-click",
  <path d="M9 9l11 4.5-4.8 1.7L13.5 20zM9 3v2.5M3 9h2.5M4.8 4.8l1.8 1.8" />,
);
export const Cpu = icon(
  "cpu",
  <>
    <rect x="6" y="6" width="12" height="12" rx="3" />
    <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
  </>,
);
export const Globe = icon("globe", <>{ring}<path d="M12 3c-3.5 3.5-3.5 14.5 0 18M12 3c3.5 3.5 3.5 14.5 0 18M3.5 9h17M3.5 15h17" /></>);
export const Network = icon(
  "network",
  <>
    <rect x="9" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="3" y="15.5" width="6" height="6" rx="1.5" />
    <rect x="15" y="15.5" width="6" height="6" rx="1.5" />
    <path d="M12 8.5V12M6 15.5V14a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1.5" />
  </>,
);
export const Settings = icon(
  "settings",
  <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
);
export const Settings2 = Settings;
export const ToggleRight = icon("toggle-right", <><rect x="2" y="6" width="20" height="12" rx="6" /><circle cx="16" cy="12" r="2.5" /></>);
export const Palette = icon(
  "palette",
  <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zM7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01" />,
);
export const Lock = icon("lock", <><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>);
export const KeyRound = icon("key-round", <><circle cx="8" cy="16" r="4.5" /><path d="M11.2 12.8L19.5 4.5M15.5 8.5l2.5 2.5M18 6l2 2" /></>);
export const Bug = icon(
  "bug",
  <>
    <rect x="7" y="7" width="10" height="14" rx="5" />
    <path d="M9 7.5V6a3 3 0 0 1 6 0v1.5M12 11v10M3 13h4M17 13h4M4 7.5l3 2M20 7.5l-3 2M4 19l3-2M20 19l-3-2" />
  </>,
);
export const Wrench = icon(
  "wrench",
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" />,
);
export const Plug = icon("plug", <path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0zM12 16v5" />);
export const Package = icon("package", <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" />);
export const Blocks = icon(
  "blocks",
  <><rect x="14" y="3" width="7" height="7" rx="2" /><path d="M10 7H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-4h-7zM3 14h7v7" /></>,
);
