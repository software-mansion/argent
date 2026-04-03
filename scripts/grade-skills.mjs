#!/usr/bin/env node
/**
 * Grades all packages/skills/skills/*\/SKILL.md files on description quality.
 *
 * Criteria (each 0 or 1, normalized to 0–10):
 *   1. Has `description` in frontmatter
 *   2. Description contains "Use when" trigger (case-insensitive)
 *   3. Description starts with capital letter + verb OR describes a workflow
 *   4. Content body has at least 2 ## headings
 *   5. Content body has numbered steps (1., 2., …) or bullet lists (- / *)
 *   6. Content length > 300 characters
 *   7. Description length > 50 characters
 *
 * Usage:
 *   node scripts/grade-skills.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const skillsRoot = join(__dir, "..", "packages", "skills", "skills");

// ─── YAML frontmatter parser (no deps) ────────────────────────────────────────

function parseFrontmatter(src) {
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: src };

  const rawFm = match[1];
  const body = src.slice(match[0].length).trimStart();

  const frontmatter = {};
  // Simple key: value parser; handles multi-line values indented with spaces
  const lines = rawFm.split(/\r?\n/);
  let currentKey = null;
  let currentVal = [];

  function flush() {
    if (currentKey !== null) {
      frontmatter[currentKey] = currentVal.join(" ").trim();
    }
  }

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      flush();
      currentKey = kvMatch[1];
      currentVal = [kvMatch[2]];
    } else if (currentKey && /^\s+/.test(line)) {
      currentVal.push(line.trim());
    } else {
      flush();
      currentKey = null;
      currentVal = [];
    }
  }
  flush();

  return { frontmatter, body };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const CRITERIA = [
  {
    id: "has_description",
    label: "Has description",
    check: ({ description }) => Boolean(description && description.length > 0),
  },
  {
    id: "use_when_trigger",
    label: '"Use when" trigger',
    check: ({ description }) => Boolean(description && /use when/i.test(description)),
  },
  {
    id: "capital_verb",
    label: "Starts with capital + verb / workflow",
    check: ({ description }) => {
      if (!description) return false;
      // Starts with a capital letter followed by a word (verb-like) or "workflow"
      return /^[A-Z][a-z]/.test(description) || /workflow/i.test(description);
    },
  },
  {
    id: "two_headings",
    label: "≥2 ## headings in body",
    check: ({ body }) => {
      const matches = body.match(/^##\s+/gm);
      return Boolean(matches && matches.length >= 2);
    },
  },
  {
    id: "has_steps_or_bullets",
    label: "Has numbered steps or bullets",
    check: ({ body }) => /^\s*\d+\.\s+/m.test(body) || /^\s*[-*]\s+/m.test(body),
  },
  {
    id: "body_length",
    label: "Body > 300 chars",
    check: ({ body }) => body.length > 300,
  },
  {
    id: "desc_length",
    label: "Description > 50 chars",
    check: ({ description }) => Boolean(description && description.length > 50),
  },
];

const MAX_SCORE = CRITERIA.length; // 7

function grade(skillPath) {
  const src = readFileSync(skillPath, "utf8");
  const { frontmatter, body } = parseFrontmatter(src);
  const description = frontmatter.description || "";

  const ctx = { description, body, frontmatter };
  const results = CRITERIA.map((c) => ({ ...c, pass: c.check(ctx) }));
  const raw = results.filter((r) => r.pass).length;
  const score = ((raw / MAX_SCORE) * 10).toFixed(1);

  return { description, body, results, raw, score };
}

// ─── Table rendering ──────────────────────────────────────────────────────────

function pad(str, width, align = "left") {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  const spaces = " ".repeat(width - s.length);
  return align === "right" ? spaces + s : s + spaces;
}

function renderTable(rows, columns) {
  // columns: [{ key, label, width, align }]
  const widths = columns.map((c) => c.width);

  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const header =
    "│" + columns.map((c) => " " + pad(c.label, c.width, c.align) + " ").join("│") + "│";

  const body = rows.map((row) => {
    return (
      "│" + columns.map((c) => " " + pad(row[c.key] ?? "", c.width, c.align) + " ").join("│") + "│"
    );
  });

  return [top, header, mid, ...body, bot].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const skillDirs = readdirSync(skillsRoot).filter((name) => {
  const full = join(skillsRoot, name);
  return statSync(full).isDirectory();
});

const allResults = [];

for (const dir of skillDirs.sort()) {
  const skillPath = join(skillsRoot, dir, "SKILL.md");
  try {
    const result = grade(skillPath);
    allResults.push({ name: dir, ...result });
  } catch (err) {
    console.error(`  Error reading ${dir}: ${err.message}`);
  }
}

// ─── Per-skill table ──────────────────────────────────────────────────────────

const criteriaColumns = [
  { key: "name", label: "Skill", width: 38, align: "left" },
  { key: "score", label: "Score", width: 5, align: "right" },
  ...CRITERIA.map((c) => ({
    key: c.id,
    label: c.label.slice(0, 22),
    width: Math.max(c.label.length, 4),
    align: "left",
  })),
];

const tableRows = allResults.map((r) => {
  const row = { name: r.name, score: r.score };
  for (const cr of r.results) {
    row[cr.id] = cr.pass ? "✓" : "✗";
  }
  return row;
});

console.log("\n Skill Description Quality Report\n");
console.log(renderTable(tableRows, criteriaColumns));

// ─── Average ──────────────────────────────────────────────────────────────────

const avg = allResults.reduce((sum, r) => sum + parseFloat(r.score), 0) / allResults.length;

console.log(`\n Average score: ${avg.toFixed(1)} / 10  (${allResults.length} skills)\n`);

// ─── Per-criterion summary ────────────────────────────────────────────────────

const summaryRows = CRITERIA.map((c) => {
  const passing = allResults.filter((r) =>
    r.results.find((cr) => cr.id === c.id && cr.pass)
  ).length;
  return {
    criterion: c.label,
    passing: `${passing} / ${allResults.length}`,
    pct: ((passing / allResults.length) * 100).toFixed(0) + "%",
  };
});

const summaryColumns = [
  { key: "criterion", label: "Criterion", width: 36, align: "left" },
  { key: "passing", label: "Passing", width: 9, align: "right" },
  { key: "pct", label: "%", width: 5, align: "right" },
];

console.log(" Criterion breakdown:\n");
console.log(renderTable(summaryRows, summaryColumns));
console.log();

// Fail if any skill scores below 10.0
const failing = allResults.filter((r) => parseFloat(r.score) < 10.0);
if (failing.length > 0) {
  console.error(
    ` ✗ ${failing.length} skill(s) scored below 10.0: ${failing.map((r) => r.name).join(", ")}`
  );
  process.exit(1);
}
console.log(" ✓ All skills scored 10.0 / 10\n");
process.exit(0);
