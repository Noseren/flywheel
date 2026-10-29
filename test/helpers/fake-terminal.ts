import type { Readable, Writable } from "node:stream";

import type { Terminal } from "@earendil-works/pi-tui";

type TtyReadable = Readable & {
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  setEncoding?(encoding: BufferEncoding): void;
};

type TtyWritable = Writable & {
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
};

export class FakeTerminal implements Terminal {
  readonly input: TtyReadable;
  readonly output: TtyWritable;
  readonly kittyProtocolActive = false;
  private inputHandler?: (chunk: Buffer | string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;

  constructor(input: Readable, output: Writable) {
    this.input = input as TtyReadable;
    this.output = output as TtyWritable;
  }

  get columns(): number { return this.output.columns ?? 100; }
  get rows(): number { return this.output.rows ?? 30; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.wasRaw = this.input.isRaw === true;
    this.input.setEncoding?.("utf8");
    this.input.setRawMode?.(true);
    this.inputHandler = (chunk) => {
      const data = chunk.toString();
      for (let index = 0; index < data.length;) {
        if (data[index] === "\u001b" && data[index + 1] === "[") {
          const match = data.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/);
          if (match) {
            onInput(match[0]);
            index += match[0].length;
            continue;
          }
        }
        const character = String.fromCodePoint(data.codePointAt(index)!);
        onInput(character);
        index += character.length;
      }
    };
    this.resizeHandler = onResize;
    this.input.on("data", this.inputHandler);
    this.output.on?.("resize", this.resizeHandler);
  }

  stop(): void {
    if (this.inputHandler) this.input.off("data", this.inputHandler);
    if (this.resizeHandler) this.output.off?.("resize", this.resizeHandler);
    this.input.setRawMode?.(this.wasRaw);
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void { this.output.write(data); }
  moveBy(lines: number): void { if (lines) this.write(`\u001b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.write("\u001b[?25l"); }
  showCursor(): void { this.write("\u001b[?25h"); }
  clearLine(): void { this.write("\u001b[2K"); }
  clearFromCursor(): void { this.write("\u001b[0J"); }
  clearScreen(): void { this.write("\u001b[2J\u001b[H"); }
  setTitle(title: string): void { this.write(`\u001b]0;${title}\u0007`); }
  setProgress(_active: boolean): void {}
}
