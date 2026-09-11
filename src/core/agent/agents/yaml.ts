/**
 * Phase 75.15 — Minimal YAML subset parser for `.toolnet/agents.yaml`.
 *
 * ToolNet ships exactly four runtime dependencies and deliberately avoids
 * pulling in a full YAML engine for one small config file. This parser covers
 * the documented agent-config grammar and nothing else:
 *
 *   - block mappings (`key:` with an indented child block)
 *   - block sequences of scalars (`- item`)
 *   - quoted / bare scalars, booleans, null, numbers
 *   - `#` comments, blank lines, a leading `---`
 *
 * Anything outside that grammar raises a descriptive error, which the loader
 * turns into a validation warning rather than a crash.
 */

export class YamlSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlSubsetError";
  }
}

interface YamlLine {
  indent: number;
  text: string;
  raw: string;
}

/** Remove a trailing `#` comment while respecting single/double quotes. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function tokenize(text: string): YamlLine[] {
  const lines: YamlLine[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    if (stripped.trim() === "---") continue;

    const indentMatch = /^[ \t]*/.exec(stripped);
    const prefix = indentMatch ? indentMatch[0] : "";
    if (prefix.includes("\t")) {
      throw new YamlSubsetError("Tabs are not supported for indentation — use spaces.");
    }

    lines.push({ indent: prefix.length, text: stripped.trim(), raw });
  }

  return lines;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}

function parseSequence(lines: YamlLine[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlSubsetError(`Unexpected indentation inside sequence: ${line.raw}`);
    }
    if (!line.text.startsWith("- ")) break;

    items.push(parseScalar(line.text.slice(2)));
    i++;
  }

  return [items, i];
}

function parseMapping(
  lines: YamlLine[],
  start: number,
  indent: number
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlSubsetError(`Unexpected indentation: ${line.raw}`);
    }
    if (line.text.startsWith("- ")) break;

    const match = /^([^:]+):(.*)$/.exec(line.text);
    if (!match) throw new YamlSubsetError(`Invalid mapping entry: ${line.raw}`);

    const key = String(parseScalar(match[1].trim()));
    const rest = match[2].trim();
    i++;

    if (rest !== "") {
      result[key] = parseScalar(rest);
      continue;
    }

    // `key:` with an indented child block (mapping or sequence).
    if (i < lines.length && lines[i].indent > indent) {
      const [child, next] = parseBlock(lines, i, lines[i].indent);
      result[key] = child;
      i = next;
      continue;
    }

    result[key] = null;
  }

  return [result, i];
}

function parseBlock(lines: YamlLine[], start: number, indent: number): [unknown, number] {
  const first = lines[start];
  if (first.text.startsWith("- ")) return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

/**
 * Parse a YAML subset document into plain JS values.
 * Throws {@link YamlSubsetError} for anything outside the supported grammar.
 */
export function parseYamlSubset(text: string): unknown {
  const lines = tokenize(text);
  if (lines.length === 0) return {};

  const [value, consumed] = parseBlock(lines, 0, lines[0].indent);

  if (consumed !== lines.length) {
    throw new YamlSubsetError(`Unexpected content at: ${lines[consumed].raw}`);
  }

  return value;
}
