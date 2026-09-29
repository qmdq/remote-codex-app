export interface TerminalSpan {
  text: string;
  style: string;
}

export interface TerminalLine {
  id: number;
  spans: TerminalSpan[];
  caret?: boolean;
}

interface TerminalCell {
  char: string;
  fg: string;
  bg: string;
  flags: string;
}

const MAX_LINES = 5000;
const MAX_CELLS = 160_000;
const BASIC_COLORS = [
  "#1f2937", "#d62f46", "#2fb463", "#c7a542",
  "#3b82f6", "#a855f7", "#22b8cf", "#d7dde8",
  "#667085", "#ff6b7d", "#57d68d", "#e6c960",
  "#70a8ff", "#c78bff", "#66e0e8", "#ffffff",
];
const CUBE = [0, 95, 135, 175, 215, 255];

function color256(index: number): string {
  const value = Math.max(0, Math.min(255, Math.floor(index)));
  if (value < 16) return BASIC_COLORS[value];
  if (value < 232) {
    const offset = value - 16;
    const blue = offset % 6;
    const green = Math.floor(offset / 6) % 6;
    const red = Math.floor(offset / 36);
    return `rgb(${CUBE[red]}, ${CUBE[green]}, ${CUBE[blue]})`;
  }
  const level = 8 + (value - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

function emptyCell(): TerminalCell {
  return { char: "", fg: "", bg: "", flags: "" };
}

function cellStyle(cell: TerminalCell): string {
  return [
    cell.fg ? `color:${cell.fg}` : "",
    cell.bg ? `background-color:${cell.bg}` : "",
    cell.flags.includes("b") ? "font-weight:700" : "",
    cell.flags.includes("d") ? "opacity:.58" : "",
    cell.flags.includes("i") ? "font-style:italic" : "",
    cell.flags.includes("u") ? "text-decoration:underline" : "",
  ].filter(Boolean).join(";");
}

export function createTerminalBuffer() {
  const lines: TerminalCell[][] = [[]];
  let cursorRow = 0;
  let cursorCol = 0;
  let lineId = 1;
  let savedRow = 0;
  let savedCol = 0;
  let current: TerminalCell = emptyCell();

  const ensureRow = (row: number) => {
    while (lines.length <= row) lines.push([]);
    if (row < 0) {
      lines.unshift([]);
      cursorRow += 1;
      return;
    }
    return lines[row];
  };

  const clearRange = (row: TerminalCell[], start: number, end: number) => {
    const from = Math.max(0, start);
    if (end < from) return;
    const count = Math.min(row.length, end + 1) - from;
    if (count > 0) row.splice(from, count);
  };

  const write = (text: string) => {
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === "\x1b") {
        index += handleEscape(text.slice(index));
        continue;
      }
      if (char === "\r") {
        cursorCol = 0;
        index += 1;
        continue;
      }
      if (char === "\n") {
        cursorRow += 1;
        cursorCol = 0;
        ensureRow(cursorRow);
        index += 1;
        continue;
      }
      if (char === "\b") {
        cursorCol = Math.max(0, cursorCol - 1);
        index += 1;
        continue;
      }
      if (char === "\t") {
        const target = cursorCol + 8 - (cursorCol % 8);
        while (cursorCol < target) {
          ensureRow(cursorRow)[cursorCol] = { ...current, char: " " };
          cursorCol += 1;
        }
        index += 1;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 32 || char === "\x7f") {
        index += 1;
        continue;
      }

      const row = ensureRow(cursorRow);
      const surrogate = code >= 0xd800 && code <= 0xdbff;
      const glyph = surrogate && index + 1 < text.length ? text.slice(index, index + 2) : char;
      row[cursorCol] = { ...current, char: glyph };
      cursorCol += 1;
      index += glyph.length;
    }
    trim();
  };

  const handleEscape = (sequence: string) => {
    if (sequence.startsWith("\x1b]")) {
      const bel = sequence.indexOf("\x07", 2);
      if (bel >= 0) return bel + 1;
      const st = sequence.indexOf("\x1b\\", 2);
      return st >= 0 ? st + 2 : sequence.length;
    }
    if (sequence.startsWith("\x1b[")) {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(sequence);
      if (!match) return sequence.length;
      const body = match[0].slice(2, -1);
      const command = match[0].slice(-1);
      applyCsi(body, command);
      return match[0].length;
    }
    if (sequence.startsWith("\x1b7")) {
      savedRow = cursorRow;
      savedCol = cursorCol;
      return 2;
    }
    if (sequence.startsWith("\x1b8")) {
      cursorRow = Math.max(0, savedRow);
      cursorCol = Math.max(0, savedCol);
      ensureRow(cursorRow);
      return 2;
    }
    if (sequence.length >= 2 && /^[()][0-9A-Za-z]/.test(sequence.slice(1, 3))) return 3;
    if (sequence.length >= 2 && /^[=>78MD]/.test(sequence[1])) return 2;
    return sequence.search(/[@-~]/) + 1 || sequence.length;
  };

  const applyCsi = (body: string, command: string) => {
    const params = body.replace(/[?]/g, "").split(";").map((part) => Number(part || 1));
    const first = Number.isFinite(params[0]) ? params[0] : 1;
    const count = Math.max(1, first || 1);

    if (command === "A") {
      cursorRow = Math.max(0, cursorRow - count);
      ensureRow(cursorRow);
      return;
    }
    if (command === "B" || command === "e") {
      cursorRow += count;
      ensureRow(cursorRow);
      return;
    }
    if (command === "C" || command === "a") {
      cursorCol += count;
      return;
    }
    if (command === "D") {
      cursorCol = Math.max(0, cursorCol - count);
      return;
    }
    if (command === "E") {
      cursorRow += count;
      cursorCol = 0;
      ensureRow(cursorRow);
      return;
    }
    if (command === "F") {
      cursorRow = Math.max(0, cursorRow - count);
      cursorCol = 0;
      ensureRow(cursorRow);
      return;
    }
    if (command === "G" || command === "`") {
      cursorCol = Math.max(0, count - 1);
      return;
    }
    if (command === "d") {
      cursorRow = Math.max(0, count - 1);
      ensureRow(cursorRow);
      return;
    }
    if (command === "H" || command === "f") {
      cursorRow = Math.max(0, (Number(params[0]) || 1) - 1);
      cursorCol = Math.max(0, (Number(params[1]) || 1) - 1);
      ensureRow(cursorRow);
      return;
    }
    if (command === "J") {
      const mode = body.includes("?") ? 0 : first;
      if (mode === 2 || mode === 3) {
        lines.length = 1;
        lines[0] = [];
        cursorRow = 0;
        cursorCol = 0;
        return;
      }
      if (mode === 1) {
        for (let row = 0; row < cursorRow; row += 1) row.length = 0;
        clearRange(lines[cursorRow] || [], 0, cursorCol);
        return;
      }
      clearRange(lines[cursorRow] || [], cursorCol, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (command === "K") {
      const row = ensureRow(cursorRow);
      if (first === 1) clearRange(row, 0, cursorCol);
      else if (first === 2) row.length = 0;
      else clearRange(row, cursorCol, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (command === "m") {
      applySgr(body.split(";"));
      return;
    }
    if (command === "h" || command === "l") {
      // Private modes are tracked by the PTY itself.
      return;
    }
  };

  const applySgr = (rawParams: string[]) => {
    if (!rawParams.length) rawParams = ["0"];
    for (let index = 0; index < rawParams.length; index += 1) {
      const code = Number(rawParams[index] || 0);
      if (code === 0) current = emptyCell();
      else if (code === 1) current.flags += current.flags.includes("b") ? "" : "b";
      else if (code === 2) current.flags += current.flags.includes("d") ? "" : "d";
      else if (code === 3) current.flags += current.flags.includes("i") ? "" : "i";
      else if (code === 4) current.flags += current.flags.includes("u") ? "" : "u";
      else if (code === 7) current.flags += current.flags.includes("r") ? "" : "r";
      else if (code === 22) current.flags = current.flags.replace(/[bd]/g, "");
      else if (code === 23) current.flags = current.flags.replace(/i/g, "");
      else if (code === 24) current.flags = current.flags.replace(/u/g, "");
      else if (code === 27) current.flags = current.flags.replace(/r/g, "");
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        current.fg = BASIC_COLORS[code >= 90 ? code - 82 : code - 30];
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        current.bg = BASIC_COLORS[code >= 100 ? code - 92 : code - 40];
      } else if (code === 39 || code === 49) {
        if (code === 39) current.fg = "";
        else current.bg = "";
      } else if (code === 38 || code === 48) {
        const type = Number(rawParams[index + 1] || 0);
        if (type === 5) {
          const color = color256(Number(rawParams[index + 2] || 0));
          if (code === 38) current.fg = color;
          else current.bg = color;
          index += 2;
        } else if (type === 2) {
          const color = `rgb(${rawParams.slice(index + 2, index + 5).map(Number).join(", ")})`;
          if (code === 38) current.fg = color;
          else current.bg = color;
          index += 4;
        }
      }
    }
  };

  const trim = () => {
    let cells = lines.reduce((total, row) => total + row.length, 0);
    while ((lines.length > MAX_LINES || cells > MAX_CELLS) && lines.length > 1) {
      const removed = lines.shift();
      cells -= removed ? removed.length : 0;
      cursorRow = Math.max(0, cursorRow - 1);
      savedRow = Math.max(0, savedRow - 1);
    }
  };

  const render = (): TerminalLine[] => lines.map((row, index) => {
    const spans: TerminalSpan[] = [];
    let text = "";
    let style = "";
    for (let col = 0; col < row.length; col += 1) {
      const cell = row[col];
      const nextText = cell?.char || " ";
      const nextStyle = cell ? cellStyle({
        char: cell.char,
        fg: cell.flags.includes("r") ? cell.bg : cell.fg,
        bg: cell.flags.includes("r") ? cell.fg : cell.bg,
        flags: cell.flags.replace(/r/g, ""),
      }) : "";
      if (text && style !== nextStyle) {
        spans.push({ text, style });
        text = "";
      }
      text += nextText;
      style = nextStyle;
    }
    if (text) spans.push({ text, style });
    return { id: index + 1, spans, caret: index === cursorRow };
  });

  const reset = () => {
    lines.length = 1;
    lines[0] = [];
    cursorRow = 0;
    cursorCol = 0;
    savedRow = 0;
    savedCol = 0;
    current = emptyCell();
  };

  return { write, render, reset };
}
