import stripAnsi from "strip-ansi";

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export class VirtualTerminal {
  private outputBuffer: string[] = [];
  private originalCols: number;
  private originalRows: number;
  private currentCols: number;
  private currentRows: number;

  constructor(cols = 80, rows = 24) {
    this.originalCols = process.stdout.columns || 80;
    this.originalRows = process.stdout.rows || 24;
    this.currentCols = cols;
    this.currentRows = rows;
  }

  public activate(): void {
    // Override stdout columns and rows for layout calculation
    Object.defineProperty(process.stdout, "columns", {
      value: this.currentCols,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      value: this.currentRows,
      configurable: true,
      writable: true,
    });
  }

  public restore(): void {
    Object.defineProperty(process.stdout, "columns", {
      value: this.originalCols,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      value: this.originalRows,
      configurable: true,
      writable: true,
    });
    this.outputBuffer = [];
  }

  public resize(cols: number, rows: number): void {
    this.currentCols = cols;
    this.currentRows = rows;
    this.activate();
  }

  public getDimensions(): TerminalDimensions {
    return { cols: this.currentCols, rows: this.currentRows };
  }

  public write(chunk: string): void {
    this.outputBuffer.push(chunk);
  }

  public getRawOutput(): string {
    return this.outputBuffer.join("");
  }

  public getCleanOutput(): string {
    return stripAnsi(this.getRawOutput());
  }

  public getLines(): string[] {
    return this.getCleanOutput().split("\n");
  }

  public clear(): void {
    this.outputBuffer = [];
  }

  public containsAnsi(pattern: string | RegExp): boolean {
    const raw = this.getRawOutput();
    if (typeof pattern === "string") {
      return raw.includes(pattern);
    }
    return pattern.test(raw);
  }

  public hasAltScreen(): boolean {
    return this.containsAnsi("\x1b[?1049h");
  }
}
