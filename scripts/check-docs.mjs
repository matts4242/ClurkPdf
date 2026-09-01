#!/usr/bin/env node
// Consistency checks for the specification documents.
//
// The original specs drifted apart because the same constraint was restated in
// several places and the copies diverged. These checks fail the build when a
// resolved contradiction reappears.
//
// No dependencies — runs on a bare Node 20.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

const fail = (check, detail) => failures.push({ check, detail });
const ok = (check) => checks.push(check);

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const docFiles = readdirSync(join(root, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`);
const markdownFiles = [...docFiles, 'README.md', 'REVIEW.md'].filter((f) =>
  existsSync(join(root, f)),
);

// Files whose job is to record what was rejected and why, so a superseded value
// appearing in them is the point rather than a regression.
const RATIONALE_FILES = new Set([
  'docs/00-decisions.md',
  'docs/99-appendix-future.md',
  'REVIEW.md',
]);

// A week spec may also name a superseded value when explaining what changed
// ("10 MB → 25 MB", "the original gave 20×20 px"). What must never reappear is a
// superseded value stated as a live requirement, so these checks run per line and
// skip lines carrying a negation or change marker.
//
// The heuristic is deliberately narrow: a new requirement written plainly ("max
// 10MB", "use pdf2pic") carries none of these markers and is still caught.
const CONTRAST_MARKERS = [
  '→', 'original', 'supersed', 'instead', 'rather than', 'no longer', 'was ',
  'never', 'not ', 'no ', 'removed', 'rejected', 'replaced', 'gone',
];

const isContrastLine = (line) => {
  const lower = line.toLowerCase();
  return CONTRAST_MARKERS.some((m) => lower.includes(m));
};

// Lines in `file` that match `pattern` and are not explaining a supersession.
const normativeMatches = (file, pattern) => {
  if (RATIONALE_FILES.has(file)) return [];
  return read(file)
    .split('\n')
    .filter((line) => pattern.test(line) && !isContrastLine(line));
};

// ---------------------------------------------------------------------------
// 1. Every expected document exists.
// ---------------------------------------------------------------------------
{
  const expected = [
    'docs/00-decisions.md',
    'docs/01-overview.md',
    'docs/week-1-upload-viewer.md',
    'docs/week-2-regions.md',
    'docs/week-3-text-layer.md',
    'docs/week-4-ocr.md',
    'docs/week-5-batch-queue.md',
    'docs/week-6-templates.md',
    'docs/week-7-export.md',
    'docs/99-appendix-future.md',
    'README.md',
    'REVIEW.md',
  ];
  const missing = expected.filter((f) => !existsSync(join(root, f)));
  if (missing.length) fail('documents exist', `missing: ${missing.join(', ')}`);
  else ok('documents exist');
}

// ---------------------------------------------------------------------------
// 2. Relative markdown links resolve.
// ---------------------------------------------------------------------------
{
  const broken = [];
  for (const file of markdownFiles) {
    const body = read(file);
    for (const [, target] of body.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target)) continue;
      const resolved = resolve(root, dirname(file), target);
      if (!existsSync(resolved)) broken.push(`${file} → ${target}`);
    }
  }
  if (broken.length) fail('markdown links resolve', broken.join('; '));
  else ok('markdown links resolve');
}

// ---------------------------------------------------------------------------
// 3. No references to the old layout or to deleted files.
// ---------------------------------------------------------------------------
{
  const stale = [];
  for (const file of markdownFiles) {
    if (RATIONALE_FILES.has(file)) continue; // REVIEW.md discusses the old layout
    const body = read(file);
    for (const pattern of ['Project_Overview', 'blank.yml', 'filestructure']) {
      if (body.includes(pattern)) stale.push(`${file}: ${pattern}`);
    }
  }
  if (stale.length) fail('no stale path references', stale.join('; '));
  else ok('no stale path references');
}

// ---------------------------------------------------------------------------
// 4. D2 — one set of file limits. The 10MB cap is gone.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of markdownFiles) {
    // 10MB / 10 MB / 10MiB, in any casing.
    for (const line of normativeMatches(file, /\b10\s?M(B|iB)\b/i)) {
      offenders.push(`${file}: ${line.trim()}`);
    }
  }
  if (offenders.length)
    fail('D2 file limits', `superseded 10MB limit stated as live: ${offenders.join('; ')}`);
  else ok('D2 file limits');
}

// ---------------------------------------------------------------------------
// 5. D9 — the pixel-based minimum region size is gone.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of markdownFiles) {
    // "20x20 pixels", "20×20 px" — the superseded client-side rule.
    for (const line of normativeMatches(file, /\b20\s?[x×]\s?20\b/i)) {
      offenders.push(`${file}: ${line.trim()}`);
    }
  }
  if (offenders.length)
    fail('D9 minimum region size', `pixel-based minimum stated as live: ${offenders.join('; ')}`);
  else ok('D9 minimum region size');
}

// ---------------------------------------------------------------------------
// 6. D5, D1, D11 — rejected technologies appear only where they are rejected.
// ---------------------------------------------------------------------------
{
  const rejected = ['FastAPI', 'Fabric.js', 'Konva', 'pdf2pic', 'pdf-poppler', 'pdf-parse'];
  const offenders = [];
  for (const file of markdownFiles) {
    for (const term of rejected) {
      // Escape the dots in package names so "pdf-parse" cannot match loosely.
      const pattern = new RegExp(term.replace(/[.]/g, '\\.'));
      for (const line of normativeMatches(file, pattern)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  if (offenders.length)
    fail('rejected technologies', `specified for use: ${offenders.join('; ')}`);
  else ok('rejected technologies');
}

// ---------------------------------------------------------------------------
// 7. D8 — a Prisma enum member is always accompanied by an @map.
//    This is the check that would have caught the original enum mismatch.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of markdownFiles) {
    // The rationale docs quote the original broken enum on purpose. The
    // authoritative schemas live in the week specs and are checked there.
    if (RATIONALE_FILES.has(file)) continue;
    const body = read(file);
    for (const [, block] of body.matchAll(/\nenum\s+\w+\s*\{([^}]*)\}/g)) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        // A TypeScript enum member assigns a value; only Prisma members need @map.
        if (trimmed.includes('=')) continue;
        // A Prisma enum member is UPPER_SNAKE; it must carry an @map.
        if (/^[A-Z][A-Z0-9_]*$/.test(trimmed.split(/\s+/)[0]) && !trimmed.includes('@map')) {
          offenders.push(`${file}: ${trimmed}`);
        }
      }
    }
  }
  if (offenders.length)
    fail('D8 enum @map', `enum member without @map: ${offenders.join('; ')}`);
  else ok('D8 enum @map');
}

// ---------------------------------------------------------------------------
// 8. Every decision is defined once and referenced by at least one week spec.
// ---------------------------------------------------------------------------
{
  const decisions = read('docs/00-decisions.md');
  const defined = [...decisions.matchAll(/^## (D\d+) —/gm)].map((m) => m[1]);

  if (defined.length === 0) {
    fail('decisions defined', 'no decisions found in 00-decisions.md');
  } else {
    const weekBodies = docFiles
      .filter((f) => f.includes('week-'))
      .map((f) => read(f))
      .join('\n');

    const unreferenced = defined.filter(
      (id) => !new RegExp(`\\b${id}\\b`).test(weekBodies),
    );
    if (unreferenced.length)
      fail('decisions referenced', `never cited by a week spec: ${unreferenced.join(', ')}`);
    else ok(`decisions referenced (${defined.length} decisions)`);

    // Decisions cited by a week spec must actually exist.
    const cited = new Set([...weekBodies.matchAll(/\*\*(D\d+)\*\*/g)].map((m) => m[1]));
    const dangling = [...cited].filter((id) => !defined.includes(id));
    if (dangling.length)
      fail('decisions resolve', `cited but not defined: ${dangling.join(', ')}`);
    else ok('decisions resolve');
  }
}

// ---------------------------------------------------------------------------
// 9. Every week spec has acceptance criteria.
// ---------------------------------------------------------------------------
{
  const missing = docFiles
    .filter((f) => f.includes('week-'))
    .filter((f) => !/##\s+Acceptance criteria/i.test(read(f)));
  if (missing.length) fail('acceptance criteria', `missing in: ${missing.join(', ')}`);
  else ok('acceptance criteria');
}

// ---------------------------------------------------------------------------
// 10. JSON files parse.
// ---------------------------------------------------------------------------
{
  const bad = [];
  for (const file of ['package.json']) {
    try {
      JSON.parse(read(file));
    } catch (err) {
      bad.push(`${file}: ${err.message}`);
    }
  }
  if (bad.length) fail('json parses', bad.join('; '));
  else ok('json parses');
}

// ---------------------------------------------------------------------------

for (const check of checks) console.log(`  ok    ${check}`);
for (const { check, detail } of failures) console.error(`  FAIL  ${check}\n        ${detail}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed.`);
