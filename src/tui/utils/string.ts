import stripAnsi from "strip-ansi";
import { A } from "../../term";

export function fillLine(text: string, width: number, fg = A.fgText, bg = A.bgSurface): string {
  const stripped = stripAnsi(text);
  const pad = Math.max(0, width - stripped.length);
  return bg + fg + text + " ".repeat(pad) + A.reset;
}

export function truncate(s: string, maxLen: number): string {
  if (stripAnsi(s).length <= maxLen) return s;
  
  let visibleLen = 0;
  let out = "";
  let inEscape = false;
  let seq = "";

  for (let i = 0; i < s.length; i++) {
    const char = s[i];
    if (char === "\x1b") {
      inEscape = true;
      seq = char;
    } else if (inEscape) {
      seq += char;
      if (char.match(/[a-zA-Z]/)) {
        inEscape = false;
        out += seq;
      }
    } else {
      if (visibleLen >= maxLen - 1) {
        return out + A.reset + "…";
      }
      out += char;
      visibleLen++;
    }
  }
  return out + A.reset;
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (para === "") { lines.push(""); continue; }
    let currentLine = "";
    let currentVisibleLen = 0;
    
    const words = para.split(" ");
    for (const word of words) {
      const wordLen = stripAnsi(word).length;
      
      if (wordLen > width) {
        if (currentLine) {
            lines.push(currentLine);
            currentLine = "";
            currentVisibleLen = 0;
        }
        let remainingWord = word;
        while (stripAnsi(remainingWord).length > width) {
          // Note: naive slice on string, assuming it has no ANSI codes
          // because wrapText is called before syntax highlight
          lines.push(remainingWord.slice(0, width)); 
          remainingWord = remainingWord.slice(width);
        }
        currentLine = remainingWord;
        currentVisibleLen = stripAnsi(remainingWord).length;
      } else if (currentVisibleLen === 0) {
        currentLine = word;
        currentVisibleLen = wordLen;
      } else if (currentVisibleLen + 1 + wordLen <= width) {
        currentLine += " " + word;
        currentVisibleLen += 1 + wordLen;
      } else {
        lines.push(currentLine);
        currentLine = word;
        currentVisibleLen = wordLen;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines.length ? lines : [""];
}
