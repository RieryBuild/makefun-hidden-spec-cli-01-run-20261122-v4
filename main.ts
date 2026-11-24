// mend — one patch tool for every AI edit format (SPEC.md v1, sections 1-10).
// Written fresh from SPEC.md plus the r5 decision list D1-D56.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

/** A file split into lines at its own break, with its final-break flag. */
interface FileDoc {
  lines: string[];
  br: string;
  fin: boolean;
}

function fileDoc(text: string): FileDoc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const lines = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    lines.pop();
    fin = true;
  }
  return { lines, br, fin };
}

function docText(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.fin ? d.br : '');
}

/** The tree as the edits leave it, plus the move pairs edits recorded. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/* ---- section 5: matching lines at three tiers ---- */

const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function eqLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}

function occurrences(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!eqLine(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  pos: number[];
}

/** First tier (0, then 1, then 2; strict: 0 only) with an occurrence at/after `from`. */
function findTier(o: string[], lines: string[], strict: boolean, from: number, eofOnly: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(o, lines, t, from).filter((p) => !eofOnly || p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One new line at tier 2: replace O's leading whitespace P by F when it starts with P. */
function reindent(t: string, p: string, f: string): string {
  if (t === '' || /^[ \t]*$/.test(t)) return t;
  if (!t.startsWith(p)) return t;
  return f + t.slice(p.length);
}

interface NewLine {
  text: string;
  /** Index into O when this is a context line, else null for an added line. */
  ctx: number | null;
}

/** Build the replacement lines for a matched occurrence (context = file's own lines). */
function replacement(n: NewLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const p = leadWs(o[0] ?? '');
  const f = leadWs(fileLines[pos] ?? '');
  return n.map((x) => {
    if (x.ctx !== null) return fileLines[pos + x.ctx]!;
    return tier === 2 ? reindent(x.text, p, f) : x.text;
  });
}

/** Split a hunk/chunk body (already stripped of trailing empty lines) into O and N. */
function splitBody(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const bl of body) {
    if (bl === '' || bl[0] === ' ') {
      const t = bl === '' ? '' : bl.slice(1);
      n.push({ text: t, ctx: o.length });
      o.push(t);
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: null });
    }
    // A line starting with `\` is a marker only, never part of O or N.
  }
  return { o, n };
}

/** A `\` line suppresses the final break only when it immediately follows the
 *  hunk's last context or `+` line (D36). */
function noNewline(body: string[]): boolean {
  let lastCP = -1;
  for (let k = 0; k < body.length; k += 1) {
    const bl = body[k]!;
    if (bl === '' || bl[0] === ' ' || bl[0] === '+') lastCP = k;
  }
  if (lastCP < 0) return false;
  return lastCP + 1 < body.length && body[lastCP + 1]![0] === '\\';
}

/* ---- section 9: JSON edits ---- */

/** One JSON edit object (section 9), or null when it is not one. */
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
      const doc = fileDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, docText({ lines, br: doc.br, fin: doc.fin }));
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

/* ---- section 6: unified diffs ---- */

interface UHunk {
  a: number;
  o: string[];
  n: NewLine[];
  noNL: boolean;
  body: string[];
}

interface USection {
  oldP: string | undefined;
  newP: string | undefined;
  /** True once a `---`/`+++` pair has named this side (D11: rename must not overwrite it). */
  pairOld: boolean;
  pairNew: boolean;
  creation: boolean;
  deletion: boolean;
  hasHunk: boolean;
  hunks: UHunk[];
}

function headerPath(raw: string): string {
  let t = raw.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const bi = rest.indexOf(' b/');
      if (bi < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, bi);
      const y = rest.slice(bi + 3);
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: x, newP: y, pairOld: false, pairNew: false, creation: false, deletion: false, hasHunk: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      if (cur === null || cur.hasHunk) {
        cur = { oldP: op, newP: np, pairOld: true, pairNew: true, creation: false, deletion: false, hasHunk: false, hunks: [] };
        sections.push(cur);
      } else {
        cur.oldP = op;
        cur.newP = np;
        cur.pairOld = true;
        cur.pairNew = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l2 = lines[j]!;
        if (l2.startsWith('diff --git ')) break;
        if (l2.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ')) break;
        if (l2 === '' || l2[0] === ' ' || l2[0] === '-' || l2[0] === '+' || l2[0] === '\\') {
          body.push(l2);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const { o, n: nn } = splitBody(body);
      cur.hunks.push({ a, o, n: nn, noNL: noNewline(body), body });
      cur.hasHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { if (!cur.pairOld) cur.oldP = line.slice('rename from '.length).trim(); }
      else if (line.startsWith('rename to ')) { if (!cur.pairNew) cur.newP = line.slice('rename to '.length).trim(); }
      else if (line === 'new file mode' || line.startsWith('new file mode ') || line.startsWith('new file mode\t')) cur.creation = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ') || line.startsWith('deleted file mode\t')) cur.deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    let oldP = sec.oldP;
    let newP = sec.newP;
    if (oldP === undefined) oldP = newP;
    if (newP === undefined) newP = oldP;
    if (oldP === undefined || newP === undefined) throw new Exit2('error: parse 1');
    const oldPath = oldP;
    const newPath = newP;
    const isCreation = oldPath === '/dev/null' || sec.creation;
    const isDeletion = !isCreation && (newPath === '/dev/null' || sec.deletion);
    const isMove = !isCreation && !isDeletion && oldPath !== newPath;
    if (isCreation) {
      return (tree: Tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        for (const h of sec.hunks) {
          for (const bl of h.body) {
            if (bl[0] === '+') plus.push(bl.slice(1));
          }
        }
        let fin = true;
        let lastH = -1;
        let lastI = -1;
        sec.hunks.forEach((h, hi) => {
          h.body.forEach((bl, bi) => {
            if (bl[0] === '+') {
              lastH = hi;
              lastI = bi;
            }
          });
        });
        if (lastH >= 0) {
          const body = sec.hunks[lastH]!.body;
          if (lastI + 1 < body.length && body[lastI + 1]![0] === '\\') fin = false;
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      };
    }
    if (isDeletion) {
      return (tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }
    return (tree: Tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let doc = fileDoc(before);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.o.length === 0) {
          const ins = Math.min(h.a + d, doc.lines.length);
          const add = h.n.map((x) => x.text);
          const next = [...doc.lines.slice(0, ins), ...add, ...doc.lines.slice(ins)];
          const fin = ins === doc.lines.length ? !h.noNL : doc.fin;
          doc = { lines: next, br: doc.br, fin };
          d += h.n.length;
        } else {
          const found = findTier(h.o, doc.lines, strict, 0, false);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let best = found.pos[0]!;
          let bd = Math.abs(best - target);
          for (const p of found.pos) {
            const dd = Math.abs(p - target);
            if (dd < bd) {
              bd = dd;
              best = p;
            }
          }
          const pos = best;
          const repl = replacement(h.n, h.o, doc.lines, pos, found.tier);
          const next = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + h.o.length)];
          const fin = pos + h.o.length === doc.lines.length ? !h.noNL : doc.fin;
          doc = { lines: next, br: doc.br, fin };
          d += h.n.length - h.o.length;
        }
      }
      const out = docText(doc);
      if (isMove) {
        tree.now.set(newPath, out);
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  oldL: string[];
  newL: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let q = s - 1; q > prevReplace; q -= 1) {
      const l = lines[q]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldL: lines.slice(s + 1, j), newL: lines.slice(j + 1, k) });
    prevPath = path;
    prevReplace = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = fileDoc(before);
    const found = findTier(b.oldL, doc.lines, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.pos[0]!;
    const p = leadWs(b.oldL[0] ?? '');
    const f = leadWs(doc.lines[pos] ?? '');
    const repl = b.newL.map((t) => (found.tier === 2 ? reindent(t, p, f) : t));
    const next = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + b.oldL.length)];
    tree.now.set(b.path, docText({ lines: next, br: doc.br, fin: doc.fin }));
  });
}

/* ---- section 8: V4A patches ---- */

interface VChunk {
  anchor: string;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: string[];
  contentLine: number[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const headerLen = (k: 'add' | 'delete' | 'update'): number => ('*** Add File: '.length + (k === 'add' ? 0 : 3));
  const secs: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = isHeader(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = lines[i]!.slice(headerLen(kind)).trim();
    let j = i + 1;
    while (j < last && isHeader(lines[j]!) === null) j += 1;
    const content: string[] = [];
    const contentLine: number[] = [];
    for (let c = i + 1; c < j; c += 1) {
      content.push(lines[c]!);
      contentLine.push(c + 1);
    }
    secs.push({ kind, path, line: i + 1, content, contentLine });
    i = j;
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((sec) => {
    if (sec.kind === 'add') {
      const raw = [...sec.content];
      const rawLine = [...sec.contentLine];
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
        raw.pop();
        rawLine.pop();
      }
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l[0] === '+') fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${rawLine[k]}`);
      }
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      for (let k = 0; k < sec.content.length; k += 1) {
        if (!blank(sec.content[k]!)) throw new Exit2(`error: parse ${sec.contentLine[k]}`);
      }
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    // Update File.
    const raw = [...sec.content];
    const rawLine = [...sec.contentLine];
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
      raw.pop();
      rawLine.pop();
    }
    let moveTo: string | null = null;
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let firstLine = true;
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      const ln = rawLine[k]!;
      if (firstLine && l.startsWith('*** Move to: ')) {
        moveTo = l.slice('*** Move to: '.length).trim();
        firstLine = false;
        continue;
      }
      firstLine = false;
      if (l.startsWith('@@')) {
        cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        continue;
      }
      if (l.trim() === '*** End of File' && l[0] === '*') {
        if (cur === null) throw new Exit2(`error: parse ${ln}`);
        cur.eof = true;
        cur = null;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (cur === null) {
          if (chunks.length === 0) {
            cur = { anchor: '', eof: false, body: [] };
            chunks.push(cur);
          } else {
            throw new Exit2(`error: parse ${ln}`);
          }
        }
        cur.body.push(l);
        continue;
      }
      throw new Exit2(`error: parse ${ln}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let doc = fileDoc(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== '') {
          let foundIdx = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let p = cursor; p < doc.lines.length; p += 1) {
              if (eqLine(ch.anchor, doc.lines[p]!, t)) {
                foundIdx = p;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) throw new Fail('no-match', sec.path);
          cursor = foundIdx + 1;
        }
        const { o, n: nn } = splitBody(ch.body);
        if (o.length === 0) {
          const ins = ch.eof ? doc.lines.length : cursor;
          const add = nn.map((x) => x.text);
          const next = [...doc.lines.slice(0, ins), ...add, ...doc.lines.slice(ins)];
          doc = { lines: next, br: doc.br, fin: doc.fin };
          cursor = ins + add.length;
        } else {
          const found = findTier(o, doc.lines, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', sec.path);
          const pos = found.pos[0]!;
          const repl = replacement(nn, o, doc.lines, pos, found.tier);
          const next = [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + o.length)];
          doc = { lines: next, br: doc.br, fin: doc.fin };
          cursor = pos + repl.length;
        }
      }
      const out = docText(doc);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(sec.path, null);
        tree.moves.push([sec.path, moveTo]);
      } else {
        tree.now.set(sec.path, out);
      }
    };
  });
}

/* ---- sections 1, 2 and 10: invocation, output, order and atomicity ---- */

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
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // State-based R lines: a recorded move qualifies only when its old path
  // existed before and does not after, and its new path did not exist before
  // and does after (D46). A qualifying R replaces that pair's D and A lines.
  const rPairs: [string, string][] = [];
  const seenR = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const key = `${oldP}\0${newP}`;
    if (seenR.has(key)) continue;
    seenR.add(key);
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.push([oldP, newP]);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const isD = was !== null && now === null;
    const isA = was === null && now !== null;
    if (isD && rPairs.some(([o]) => o === p)) continue;
    if (isA && rPairs.some(([, n]) => n === p)) continue;
    rows.push({ key: p, text: `${isA ? 'A' : isD ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
