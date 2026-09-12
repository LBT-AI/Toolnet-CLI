/**
 * Eval fixture with an intentional bug: `slug` forgets to lowercase.
 */
export function slug(input: string): string {
  return input.trim();
}
