/**
 * Phase 77.5 — Plugin compatibility gate.
 *
 * npm plugins may declare `compatibleToolNet: ">=1.2.0 <2"`. An incompatible
 * plugin is SKIPPED with a structured warning — it never aborts startup.
 * Local file plugins are treated as development code and skip this gate
 * entirely, so an in-repo plugin can be iterated without version churn.
 *
 * Supports the range forms that actually appear in package metadata:
 *   `1.2.3`  `=1.2.3`  `>=1.2.0`  `>1.2`  `<=2.0.0`  `<2`  `^1.2.0`  `~1.2.0`
 *   space-separated AND groups: `>=1.2.0 <2`
 *   `||`-separated OR groups: `^1.0.0 || ^2.0.0`
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** Parse a semver-ish string. Returns null when it is not a version. */
export function parseVersion(raw: string): Semver | null {
  if (typeof raw !== "string") return null;
  const match = raw.trim().replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4],
  };
}

export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfiesComparator(version: Semver, comparator: string): boolean {
  const trimmed = comparator.trim();
  if (!trimmed) return true;

  const match = trimmed.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
  if (!match) return false;

  const operator = match[1] ?? "=";
  const target = parseVersion(match[2]);
  // Unparseable constraint must not silently pass — fail closed.
  if (!target) return false;

  switch (operator) {
    case "=":
      return compareVersions(version, target) === 0;
    case ">":
      return compareVersions(version, target) > 0;
    case ">=":
      return compareVersions(version, target) >= 0;
    case "<":
      return compareVersions(version, target) < 0;
    case "<=":
      return compareVersions(version, target) <= 0;
    case "^": {
      // Caret allows changes that do not modify the left-most non-zero digit.
      if (compareVersions(version, target) < 0) return false;
      if (target.major > 0) return version.major === target.major;
      if (target.minor > 0) return version.major === 0 && version.minor === target.minor;
      return version.major === 0 && version.minor === 0 && version.patch === target.patch;
    }
    case "~": {
      if (compareVersions(version, target) < 0) return false;
      return version.major === target.major && version.minor === target.minor;
    }
    default:
      return false;
  }
}

/** True when `version` satisfies `range`. Unparseable ranges fail closed. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (typeof range !== "string" || !range.trim()) return true;
  if (range.trim() === "*") return true;

  return range
    .split("||")
    .some((orGroup) =>
      orGroup
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => satisfiesComparator(parsed, comparator)),
    );
}
