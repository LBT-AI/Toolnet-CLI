import { printToolStart, printToolEnd } from "../lib/tool-format";

export function formatToolStart(toolName: string, args: any): string {
  return printToolStart(toolName, args);
}

export function formatToolEnd(toolName: string, args: any, isSuccess: boolean): string {
  return printToolEnd(toolName, args, isSuccess);
}
