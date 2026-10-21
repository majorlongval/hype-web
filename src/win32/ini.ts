interface Line {
  raw: string;
  section?: string;
  key?: string;
}

function parse(text: string): Line[] {
  return text.split(/\r?\n/).map((raw) => {
    const t = raw.trim();
    const sm = /^\[(.*)\]/.exec(t);
    if (sm) return { raw, section: sm[1].trim() };
    const eq = t.indexOf("=");
    if (eq > 0 && !t.startsWith(";")) return { raw, key: t.slice(0, eq).trim() };
    return { raw };
  });
}

function unquote(v: string): string {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** Section list (section null), key list (key null), or value. */
export function iniGet(text: string, section: string | null, key: string | null): string | string[] | null {
  const lines = parse(text);
  if (section === null) return lines.filter((l) => l.section !== undefined).map((l) => l.section!);
  const sec = section.toLowerCase();
  let inSec = false;
  const keys: string[] = [];
  for (const l of lines) {
    if (l.section !== undefined) {
      inSec = l.section.toLowerCase() === sec;
      continue;
    }
    if (!inSec || l.key === undefined) continue;
    if (key === null) keys.push(l.key);
    else if (l.key.toLowerCase() === key.toLowerCase()) return unquote(l.raw.slice(l.raw.indexOf("=") + 1));
  }
  return key === null ? keys : null;
}

/** Sets (value non-null), deletes a key (value null), or deletes a section (key null). */
export function iniSet(text: string, section: string, key: string | null, value: string | null): string {
  const lines = parse(text).filter((l, i, arr) => !(i === arr.length - 1 && l.raw === ""));
  const sec = section.toLowerCase();
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].section !== undefined) {
      if (start >= 0) { end = i; break; }
      if (lines[i].section!.toLowerCase() === sec) start = i;
    }
  }
  if (key === null) {
    if (start >= 0) lines.splice(start, end - start);
  } else if (start < 0) {
    if (value !== null) lines.push({ raw: `[${section}]` }, { raw: `${key}=${value}` });
  } else {
    let found = -1;
    for (let i = start + 1; i < end; i++) if (lines[i].key?.toLowerCase() === key.toLowerCase()) { found = i; break; }
    if (found >= 0) {
      if (value === null) lines.splice(found, 1);
      else lines[found] = { raw: `${key}=${value}`, key };
    } else if (value !== null) {
      let at = end;
      while (at > start + 1 && lines[at - 1].raw.trim() === "") at--;
      lines.splice(at, 0, { raw: `${key}=${value}`, key });
    }
  }
  return lines.map((l) => l.raw).join("\r\n") + "\r\n";
}
