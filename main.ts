// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old, new) pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5) and file text handling (section 3)
// ---------------------------------------------------------------------------

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function rtrimWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All positions i where O matches lines[i..] at the given tier, at or after `from`. */
function occurrencesAt(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const occ = occurrencesAt(O, lines, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** Build the lines that replace a matched O at position `pos`, at the tier O was found at. */
function buildReplacement(O: string[], N: NLine[], fileLines: string[], pos: number, tier: number): string[] {
  const F = leadingWS(fileLines[pos]!);
  const P = leadingWS(O[0]!);
  return N.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    let t = n.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    return t;
  });
}

/** A file's text split into its lines, with its line break and whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { br, lines, final: fin };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** One body line of a unified hunk or a V4A chunk, with its raw patch line kept. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

function bodyItem(raw: string): BodyItem {
  if (raw === '') return { kind: 'ctx', text: '', raw };
  if (raw[0] === ' ') return { kind: 'ctx', text: raw.slice(1), raw };
  if (raw[0] === '-') return { kind: 'del', text: raw.slice(1), raw };
  if (raw[0] === '+') return { kind: 'add', text: raw.slice(1), raw };
  return { kind: 'bs', text: raw.slice(1), raw };
}

/** A hunk (unified) or chunk (V4A): O lines, N lines, plus the `+` lines alone. */
interface Hunk {
  /** Unified old start, 1-based (A); unused for V4A chunks. */
  A: number;
  O: string[];
  N: NLine[];
  /** The `+` lines alone, in order (unified creations are built from these). */
  plus: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
  /** V4A: anchored to the end of the file. */
  eof: boolean;
  /** V4A: anchor text, or null for no anchor. */
  anchor: string | null;
}

function itemsToHunk(items: BodyItem[], A: number, anchor: string | null = null, eof = false): Hunk {
  const O: string[] = [];
  const N: NLine[] = [];
  const plus: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push({ text: it.text, ctx: O.length - 1 });
    } else if (it.kind === 'del') {
      O.push(it.text);
    } else if (it.kind === 'add') {
      N.push({ text: it.text, ctx: null });
      plus.push(it.text);
    }
  }
  let noFinalBreak = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'add') {
      noFinalBreak = items[k + 1] !== undefined && items[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { A, O, N, plus, noFinalBreak, eof, anchor };
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function hunkStart(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

/** The body after a hunk header at lines[i]: body items and the index past the body. */
function hunkBody(lines: string[], i: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `--- ` line followed by a `+++ ` line: that pair starts a new section,
    // so it is not a `-` line (its text would be `-- ...`) even though it starts with `-`.
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      items.push(bodyItem(l));
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0 && items[items.length - 1]!.raw === '') items.pop();
  return { items, next: j };
}

/** The path a `--- ` / `+++ ` header line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  let p = raw;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

interface UniSection {
  /** From `diff --git`, or null when the section started at a `--- ` line. */
  diffOld: string | null;
  diffNew: string | null;
  /** From the `--- ` / `+++ ` pair; undefined when the section has no pair (null: /dev/null). */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  /** Per-hunk body items, flattened for the creation final-break check. */
  items: BodyItem[][];
}

function parseUnifiedSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const start = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s: UniSection = {
      diffOld,
      diffNew,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
      items: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = start(m[1]!, m[2]!);
      inHeader = true;
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const A = hunkStart(line, i + 1);
        const { items, next } = hunkBody(lines, i + 1);
        cur.hunks.push(itemsToHunk(items, A));
        cur.items.push(items);
        inHeader = false;
        i = next;
        continue;
      }
      // Any other header line is ignored.
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = start(null, null);
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = hunkStart(line, i + 1);
      const { items, next } = hunkBody(lines, i + 1);
      cur.hunks.push(itemsToHunk(items, A));
      cur.items.push(items);
      i = next;
      continue;
    }
    // Prose and anything else outside a body is ignored.
    i++;
  }
  return sections;
}

/** Apply one unified hunk to a file state; returns the new d for the section. */
function applyUnifiedHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): number {
  if (h.O.length === 0) {
    const oldLen = st.lines.length;
    const pos = Math.max(0, Math.min(h.A + d, oldLen));
    st.lines.splice(pos, 0, ...h.N.map((n) => n.text));
    if (pos === oldLen) st.final = !h.noFinalBreak;
    return d + h.N.length;
  }
  const found = findTier(h.O, st.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.occ[0]!;
  for (const o of found.occ) {
    if (Math.abs(o - target) < Math.abs(best - target)) best = o;
  }
  const atEnd = best + h.O.length === st.lines.length;
  const rep = buildReplacement(h.O, h.N, st.lines, best, found.tier);
  st.lines.splice(best, h.O.length, ...rep);
  if (atEnd) st.final = !h.noFinalBreak;
  return d + (h.N.length - h.O.length);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldPath: string | null = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
    const newPath: string | null = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew;
    return (tree: Tree) => {
      const isCreate = oldPath === null || s.newFile;
      const isDelete = !isCreate && (newPath === null || s.deletedFile);
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (isCreate) {
        if (newPath === null) throw new Fail('unsafe', '');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus = s.hunks.flatMap((h) => h.plus);
        let noBreak = false;
        const all = s.items.flat();
        for (let k = all.length - 1; k >= 0; k--) {
          if (all[k]!.kind === 'add') {
            noBreak = all[k + 1] !== undefined && all[k + 1]!.kind === 'bs';
            break;
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldPath === null) throw new Fail('unsafe', '');
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath === null || newPath === null) throw new Fail('unsafe', '');
      if (oldPath !== newPath) {
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const st = splitFile(before);
        let d = 0;
        for (const h of s.hunks) d = applyUnifiedHunk(st, h, d, strict, oldPath);
        tree.now.set(newPath, joinFile(st));
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
        return;
      }
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const st = splitFile(before);
      let d = 0;
      for (const h of s.hunks) d = applyUnifiedHunk(st, h, d, strict, oldPath);
      tree.now.set(oldPath, joinFile(st));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevEnd = rep + 1;
      prevPath = path;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const st = splitFile(before);
    const found = findTier(b.oldLines, st.lines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(b.oldLines, N, st.lines, pos, found.tier);
    st.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(st));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

function findAnchor(anchor: string, lines: string[], strict: boolean, from: number): number | null {
  for (const tier of tiersToTry(strict)) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(anchor, lines[k]!, tier)) return k;
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    startNo: number;
    body: { text: string; no: number }[];
  }
  const rawSections: RawSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(prefix.length).trim();
    const startNo = i + 1;
    const body: { text: string; no: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, no: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    rawSections.push({ kind, path, startNo, body });
  }
  if (rawSections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const sec of rawSections) {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of sec.body) {
        if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else if (b.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const path = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (sec.kind === 'delete') {
      if (sec.body.length > 0) throw new Exit2(`error: parse ${sec.body[0]!.no}`);
      const path = sec.path;
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // Update File: optional `*** Move to:` first line, then chunks.
    let idx = 0;
    let moveTo: string | undefined;
    if (sec.body.length > 0 && sec.body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = sec.body[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: Hunk[] = [];
    let cur: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
    let firstChunk = true;
    const closeChunk = (): void => {
      if (cur !== null) {
        chunks.push(itemsToHunk(cur.items, 0, cur.anchor, cur.eof));
        cur = null;
      }
    };
    for (; idx < sec.body.length; idx++) {
      const b = sec.body[idx]!;
      const t = b.text;
      if (t.startsWith('@@')) {
        closeChunk();
        const anchorText = t.slice(2).trim();
        cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
        firstChunk = false;
        continue;
      }
      const isEof = t.trim() === '*** End of File' && t !== '' && t[0] !== ' ' && t[0] !== '-' && t[0] !== '+';
      if (isEof) {
        if (cur === null) throw new Exit2(`error: parse ${b.no}`);
        cur.eof = true;
        closeChunk();
        firstChunk = false;
        continue;
      }
      if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${b.no}`);
          cur = { anchor: null, eof: false, items: [] };
          firstChunk = false;
        }
        cur.items.push(bodyItem(t));
        continue;
      }
      throw new Exit2(`error: parse ${b.no}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${sec.startNo}`);
    const path = sec.path;
    edits.push((tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const st = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = findAnchor(ch.anchor, st.lines, strict, cursor);
          if (at === null) throw new Fail('no-match', path);
          cursor = at + 1;
        }
        if (ch.O.length === 0) {
          const pos = ch.eof ? st.lines.length : cursor;
          st.lines.splice(pos, 0, ...ch.N.map((n) => n.text));
          cursor = pos + ch.N.length;
          continue;
        }
        const found = findTier(ch.O, st.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let occ = found.occ;
        if (ch.eof) {
          occ = occ.filter((o) => o + ch.O.length === st.lines.length);
          if (occ.length === 0) throw new Fail('no-match', path);
        }
        const pos = occ[0]!;
        const rep = buildReplacement(ch.O, ch.N, st.lines, pos, found.tier);
        st.lines.splice(pos, ch.O.length, ...rep);
        cursor = pos + rep.length;
      }
      const text = joinFile(st);
      if (moveTo !== undefined) {
        tree.now.set(moveTo, text);
        tree.now.set(path, null);
        tree.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, text);
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Entry point (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const replaced = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      replaced.add(o);
      replaced.add(n);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    if (replaced.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
