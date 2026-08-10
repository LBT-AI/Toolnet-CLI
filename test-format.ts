import { printToolStart, printToolEnd } from "./src/lib/tool-format";

console.log(printToolStart("get_cwd", {}));
console.log(printToolEnd("list_dir", { path: "/root" }, true));
console.log(printToolEnd("list_dir", { path: "/root/.gemini" }, true));
console.log(printToolEnd("shell", { command: "which gemini" }, true));
console.log(printToolEnd("read_file", { path: "package.json" }, false));
