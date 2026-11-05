/**
 * Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow,
 * `*` wildcards, `$` end anchors, longest match wins, ties go to Allow.
 */

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface RobotsPolicy {
  isAllowed(pathAndQuery: string): boolean;
}

export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
export const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false };

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

export function parseRobots(text: string, productToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value === "") continue; // empty Disallow = allow everything
      current.rules.push({ allow: key === "allow", pattern: value, regex: toRegex(value) });
    } else {
      lastWasAgent = false;
    }
  }

  const token = productToken.toLowerCase();
  let applicable = groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  if (applicable.length === 0) applicable = groups.filter((g) => g.agents.includes("*"));
  const rules = applicable.flatMap((g) => g.rules);
  if (rules.length === 0) return ALLOW_ALL;

  return {
    isAllowed(pathAndQuery: string) {
      let best: Rule | undefined;
      for (const r of rules) {
        if (!r.regex.test(pathAndQuery)) continue;
        if (
          !best ||
          r.pattern.length > best.pattern.length ||
          (r.pattern.length === best.pattern.length && r.allow)
        ) {
          best = r;
        }
      }
      return best ? best.allow : true;
    },
  };
}
