/**
 * Minimal, dependency-free YAML subset parser (enough for OpenAPI documents).
 * Supports: block mappings/sequences, scalars (plain/quoted), flow [..] / {..},
 * block scalars (| and >), comments, multi-line plain/quoted scalars, "<<" ignored.
 * Not supported: anchors/aliases, tags, multi-document streams, complex keys.
 */

interface Line {
  indent: number;
  text: string; // trimmed, comment-stripped
  raw: string;
}

export class YamlError extends Error {}

function stripComment(s: string): string {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD) {
      if (c === '\\') i++;
      else if (c === '"') inD = false;
    } else if (inS) {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else inS = false;
      }
    } else if (c === '"' && (i === 0 || /[\s\[{,:-]/.test(s[i - 1]))) inD = true;
    else if (c === "'" && (i === 0 || /[\s\[{,:-]/.test(s[i - 1]))) inS = true;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function findKeyColon(s: string): number {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inD) {
      if (c === '\\') i++;
      else if (c === '"') inD = false;
    } else if (inS) {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else inS = false;
      }
    } else if (c === '"' && i === 0) inD = true;
    else if (c === "'" && i === 0) inS = true;
    else if ((c === '[' || c === '{') && i === 0) depth++;
    else if (depth > 0 && (c === ']' || c === '}')) depth--;
    else if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ' || s[i + 1] === '\t')) return i;
  }
  return -1;
}

function unquoteDouble(s: string): string {
  try {
    return JSON.parse(s);
  } catch {
    return s
      .slice(1, -1)
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[c] ?? c);
  }
}

function plainScalar(s: string): unknown {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  return t;
}

/** Parses scalar or flow collection from a complete inline string. */
function parseInline(s: string): unknown {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unquoteDouble(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('[') || t.startsWith('{')) {
    const p = { s: t, i: 0 };
    const v = parseFlow(p);
    skipWs(p);
    if (p.i !== p.s.length) throw new YamlError(`Unexpected trailing characters in flow collection: ${t}`);
    return v;
  }
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    if (t.startsWith('*')) throw new YamlError('YAML aliases are not supported');
  }
  return plainScalar(t);
}

function skipWs(p: { s: string; i: number }) {
  while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
}

function parseFlow(p: { s: string; i: number }): unknown {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '[') {
    p.i++;
    const arr: unknown[] = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === ']') {
        p.i++;
        return arr;
      }
      arr.push(parseFlow(p));
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== ']') throw new YamlError(`Bad flow sequence: ${p.s}`);
    }
  }
  if (c === '{') {
    p.i++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === '}') {
        p.i++;
        return obj;
      }
      const key = parseFlowScalar(p, true);
      skipWs(p);
      let val: unknown = null;
      if (p.s[p.i] === ':') {
        p.i++;
        skipWs(p);
        if (p.s[p.i] !== ',' && p.s[p.i] !== '}') val = parseFlow(p);
      }
      obj[String(key)] = val;
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== '}') throw new YamlError(`Bad flow mapping: ${p.s}`);
    }
  }
  return parseFlowScalar(p, false);
}

function parseFlowScalar(p: { s: string; i: number }, isKey: boolean): unknown {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '"') {
    let j = p.i + 1;
    while (j < p.s.length && p.s[j] !== '"') j += p.s[j] === '\\' ? 2 : 1;
    const raw = p.s.slice(p.i, j + 1);
    p.i = j + 1;
    return unquoteDouble(raw);
  }
  if (c === "'") {
    let j = p.i + 1;
    for (; j < p.s.length; j++) {
      if (p.s[j] === "'") {
        if (p.s[j + 1] === "'") j++;
        else break;
      }
    }
    const raw = p.s.slice(p.i + 1, j);
    p.i = j + 1;
    return raw.replace(/''/g, "'");
  }
  if (c === '[' || c === '{') return parseFlow(p);
  let j = p.i;
  while (j < p.s.length) {
    const ch = p.s[j];
    if (ch === ',' || ch === ']' || ch === '}') break;
    if (ch === ':' && (isKey || true) && (j + 1 >= p.s.length || /[\s,\]}]/.test(p.s[j + 1]))) break;
    j++;
  }
  const raw = p.s.slice(p.i, j);
  p.i = j;
  return plainScalar(raw);
}

class Parser {
  lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  next(i: number): number {
    while (i < this.lines.length && this.lines[i].text === '') i++;
    return i;
  }

  parseDocument(): unknown {
    let i = this.next(0);
    if (i >= this.lines.length) return null;
    if (this.lines[i].text === '---') i = this.next(i + 1);
    if (i >= this.lines.length) return null;
    const [v, end] = this.parseNode(i, this.lines[i].indent);
    const rest = this.next(end);
    if (rest < this.lines.length && this.lines[rest].text !== '...' && !/^---/.test(this.lines[rest].text)) {
      throw new YamlError(`Unexpected content at line ${rest + 1}: ${this.lines[rest].raw.trim()}`);
    }
    return v;
  }

  parseNode(i: number, indent: number): [unknown, number] {
    const line = this.lines[i];
    if (line.text === '-' || line.text.startsWith('- ')) return this.parseSeq(i, indent);
    if (findKeyColon(line.text) >= 0) return this.parseMap(i, indent);
    // Plain/quoted/flow scalar spanning possibly several lines
    return this.parseMultiline(i, indent - 1, line.text);
  }

  /** Reads an inline value starting on line i (text), joining continuation lines indented > parentIndent. */
  parseMultiline(i: number, parentIndent: number, text: string): [unknown, number] {
    let j = i + 1;
    const first = text.trim();
    const isDouble = first.startsWith('"');
    const isSingle = first.startsWith("'");
    const isFlow = first.startsWith('[') || first.startsWith('{');
    const closed = (s: string): boolean => {
      if (isDouble) return /^"([^"\\]|\\.)*"$/s.test(s.trim());
      if (isSingle) return /^'([^']|'')*'$/s.test(s.trim());
      if (isFlow) {
        let d = 0;
        let inS = false;
        let inD = false;
        for (let k = 0; k < s.length; k++) {
          const c = s[k];
          if (inD) {
            if (c === '\\') k++;
            else if (c === '"') inD = false;
          } else if (inS) {
            if (c === "'") inS = false;
          } else if (c === '"') inD = true;
          else if (c === "'") inS = true;
          else if (c === '[' || c === '{') d++;
          else if (c === ']' || c === '}') d--;
        }
        return d <= 0;
      }
      return true;
    };
    let acc = first;
    if (isFlow || isDouble || isSingle) {
      while (!closed(acc) && j < this.lines.length) {
        const l = this.lines[j];
        acc += (isFlow ? ' ' : l.text === '' ? '\n' : ' ') + l.text;
        j++;
      }
      return [parseInline(acc), j];
    }
    // plain multi-line
    while (j < this.lines.length) {
      const l = this.lines[j];
      if (l.text === '') {
        // blank line inside plain scalar: look ahead
        const k = this.next(j);
        if (k < this.lines.length && this.lines[k].indent > parentIndent && findKeyColon(this.lines[k].text) < 0 && !this.lines[k].text.startsWith('- ')) {
          acc += '\n';
          j = k;
          continue;
        }
        break;
      }
      if (l.indent <= parentIndent) break;
      if (findKeyColon(l.text) >= 0 || l.text.startsWith('- ')) break;
      acc += (acc.endsWith('\n') ? '' : ' ') + l.text;
      j++;
    }
    return [parseInline(acc), j];
  }

  parseBlockScalar(i: number, parentIndent: number, header: string): [string, number] {
    // header like "|", ">-", "|+", "|2"
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    let j = i + 1;
    const body: string[] = [];
    let blockIndent = -1;
    const explicit = header.match(/[1-9]/);
    if (explicit) blockIndent = parentIndent + Number(explicit[0]);
    while (j < this.lines.length) {
      const l = this.lines[j];
      const raw = l.raw.replace(/\r$/, '');
      if (raw.trim() === '') {
        body.push('');
        j++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (blockIndent < 0) blockIndent = ind;
      if (ind <= parentIndent || ind < blockIndent) break;
      body.push(raw.slice(blockIndent));
      j++;
    }
    // trailing blank lines handling
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let out: string;
    if (style === '|') out = body.join('\n');
    else {
      out = '';
      for (let k = 0; k < body.length; k++) {
        if (k === 0) out = body[k];
        else if (body[k] === '') out += '\n';
        else if (body[k - 1] === '' || body[k].startsWith(' ')) out += (body[k - 1] === '' ? '' : '\n') + body[k];
        else out += ' ' + body[k];
      }
    }
    if (body.length) {
      if (chomp === 'clip') out += '\n';
      else if (chomp === 'keep') out += '\n'.repeat(trailing + 1);
    }
    return [out, j];
  }

  parseMap(i: number, indent: number): [Record<string, unknown>, number] {
    const obj: Record<string, unknown> = {};
    while (i < this.lines.length) {
      i = this.next(i);
      if (i >= this.lines.length) break;
      const line = this.lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(`Bad indentation at line ${i + 1}: ${line.raw.trim()}`);
      if (line.text === '---' || line.text === '...') break;
      const colon = findKeyColon(line.text);
      if (colon < 0) throw new YamlError(`Expected "key: value" at line ${i + 1}: ${line.raw.trim()}`);
      let keyRaw = line.text.slice(0, colon).trim();
      const key = String(
        keyRaw.startsWith('"') ? unquoteDouble(keyRaw) : keyRaw.startsWith("'") ? keyRaw.slice(1, -1).replace(/''/g, "'") : keyRaw,
      );
      const rest = line.text.slice(colon + 1).trim();
      let value: unknown;
      if (rest === '' || rest.startsWith('&')) {
        const nx = this.next(i + 1);
        if (nx < this.lines.length && (this.lines[nx].indent > indent || (this.lines[nx].indent === indent && (this.lines[nx].text === '-' || this.lines[nx].text.startsWith('- '))))) {
          [value, i] = this.parseNode(nx, this.lines[nx].indent);
        } else {
          value = null;
          i = i + 1;
        }
      } else if (/^[|>][-+0-9]*$/.test(rest)) {
        [value, i] = this.parseBlockScalar(i, indent, rest);
      } else {
        [value, i] = this.parseMultiline(i, indent, rest);
      }
      if (key !== '<<') obj[key] = value;
    }
    return [obj, i];
  }

  parseSeq(i: number, indent: number): [unknown[], number] {
    const arr: unknown[] = [];
    while (i < this.lines.length) {
      i = this.next(i);
      if (i >= this.lines.length) break;
      const line = this.lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(`Bad indentation at line ${i + 1}: ${line.raw.trim()}`);
      if (!(line.text === '-' || line.text.startsWith('- '))) break;
      const after = line.text.slice(1);
      const rest = after.trim();
      if (rest === '') {
        const nx = this.next(i + 1);
        if (nx < this.lines.length && this.lines[nx].indent > indent) {
          let v: unknown;
          [v, i] = this.parseNode(nx, this.lines[nx].indent);
          arr.push(v);
        } else {
          arr.push(null);
          i++;
        }
        continue;
      }
      const offset = 1 + (after.length - after.trimStart().length);
      if (/^[|>][-+0-9]*$/.test(rest)) {
        let v: string;
        [v, i] = this.parseBlockScalar(i, indent, rest);
        arr.push(v);
        continue;
      }
      if (rest.startsWith('- ') || rest === '-' || findKeyColon(rest) >= 0) {
        // Re-interpret the remainder as a nested node at virtual indent.
        this.lines[i] = { indent: indent + offset, text: rest, raw: ' '.repeat(indent + offset) + rest };
        let v: unknown;
        [v, i] = this.parseNode(i, indent + offset);
        arr.push(v);
        continue;
      }
      let v: unknown;
      [v, i] = this.parseMultiline(i, indent, rest);
      arr.push(v);
    }
    return [arr, i];
  }
}

export function parseYaml(text: string): unknown {
  const rawLines = text.replace(/^\uFEFF/, '').split('\n');
  const lines: Line[] = rawLines.map((raw) => {
    const r = raw.replace(/\r$/, '');
    if (r.includes('\t') && /^\t/.test(r)) throw new YamlError('Tabs are not allowed for indentation in YAML');
    const stripped = stripComment(r);
    const trimmed = stripped.trim();
    const indent = r.length - r.trimStart().length;
    return { indent, text: trimmed === '%YAML' ? '' : trimmed, raw: r };
  });
  return new Parser(lines).parseDocument();
}
