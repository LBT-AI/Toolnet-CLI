/**
 * Eval fixture with an intentional bug: `add` subtracts instead of adding.
 * The accompanying test fails until the bug is fixed.
 */
export function add(a: number, b: number): number {
  return a - b;
}
