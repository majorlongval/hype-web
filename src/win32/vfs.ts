/** Read-only content provider for a file (host disk, OPFS, or a disc image). */
export interface FileSource {
  readonly size: number;
  read(offset: number, dst: Uint8Array, dstOff: number, len: number): number;
}

/** Where written files are persisted (save games, config). */
export interface PersistStore {
  save(path: string, data: Uint8Array): void;
  remove(path: string): void;
}

export class MemSource implements FileSource {
  constructor(public data: Uint8Array) {}
  get size(): number {
    return this.data.length;
  }
  read(offset: number, dst: Uint8Array, dstOff: number, len: number): number {
    const n = Math.max(0, Math.min(len, this.data.length - offset));
    dst.set(this.data.subarray(offset, offset + n), dstOff);
    return n;
  }
}

export class VNode {
  children: Map<string, VNode> | null;
  src: FileSource | null = null;
  data: Uint8Array | null = null;
  size = 0;
  mtime = Date.now();
  readonly = false;
  attrs = 0;
  persist = false;

  constructor(
    public name: string,
    dir: boolean,
    public parent: VNode | null,
  ) {
    this.children = dir ? new Map() : null;
  }
  get isDir(): boolean {
    return this.children !== null;
  }
  get length(): number {
    return this.data ? this.size : this.src ? this.src.size : 0;
  }
  /** Copy-on-write: materialize content so it can be modified. */
  makeWritable(): void {
    if (this.data) return;
    const n = this.src ? this.src.size : 0;
    const buf = new Uint8Array(Math.max(16, n));
    if (this.src && n) this.src.read(0, buf, 0, n);
    this.data = buf;
    this.size = n;
    this.src = null;
  }
  read(pos: number, dst: Uint8Array, dstOff: number, len: number): number {
    if (this.data) {
      const n = Math.max(0, Math.min(len, this.size - pos));
      dst.set(this.data.subarray(pos, pos + n), dstOff);
      return n;
    }
    return this.src ? this.src.read(pos, dst, dstOff, len) : 0;
  }
  write(pos: number, src: Uint8Array): number {
    this.makeWritable();
    const end = pos + src.length;
    if (end > this.data!.length) {
      const nb = new Uint8Array(Math.max(end, this.data!.length * 2));
      nb.set(this.data!.subarray(0, this.size));
      this.data = nb;
    }
    this.data!.set(src, pos);
    if (end > this.size) this.size = end;
    this.mtime = Date.now();
    return src.length;
  }
  truncate(n: number): void {
    this.makeWritable();
    if (n > this.data!.length) {
      const nb = new Uint8Array(n);
      nb.set(this.data!.subarray(0, this.size));
      this.data = nb;
    } else if (n > this.size) this.data!.fill(0, this.size, n);
    this.size = n;
  }
  path(): string {
    const parts: string[] = [];
    let n: VNode | null = this;
    while (n && n.parent) {
      parts.unshift(n.name);
      n = n.parent;
    }
    return (n ? n.name : "") + "\\" + parts.join("\\");
  }
}

export interface DriveInfo {
  letter: string;
  type: number;
  label: string;
  serial: number;
  fs: string;
}

export const DRIVE_FIXED = 3, DRIVE_CDROM = 5;

export class VFS {
  readonly drives = new Map<string, { root: VNode; info: DriveInfo }>();
  cwd = "C:\\";
  persist: PersistStore | null = null;

  addDrive(info: DriveInfo): VNode {
    const root = new VNode(info.letter + ":", true, null);
    this.drives.set(info.letter.toUpperCase(), { root, info });
    return root;
  }

  /** Full canonical path (keeps the caller's case) or null if malformed. */
  full(path: string): string | null {
    let p = path.replace(/\//g, "\\");
    if (p.startsWith("\\\\?\\")) p = p.slice(4);
    let drive: string;
    let rest: string;
    if (/^[A-Za-z]:/.test(p)) {
      drive = p[0].toUpperCase();
      rest = p.slice(2);
      if (!rest.startsWith("\\")) {
        const cwdDrive = this.cwd[0].toUpperCase();
        rest = (drive === cwdDrive ? this.cwd.slice(2) + "\\" : "\\") + rest;
      }
    } else if (p.startsWith("\\")) {
      drive = this.cwd[0].toUpperCase();
      rest = p;
    } else {
      drive = this.cwd[0].toUpperCase();
      rest = this.cwd.slice(2) + "\\" + p;
    }
    const out: string[] = [];
    for (let part of rest.split("\\")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      part = part.replace(/[. ]+$/, "");
      if (part === "") continue;
      out.push(part);
    }
    return drive + ":\\" + out.join("\\");
  }

  lookup(path: string): VNode | null {
    const f = this.full(path);
    if (!f) return null;
    const d = this.drives.get(f[0]);
    if (!d) return null;
    let n = d.root;
    for (const part of f.slice(3).split("\\")) {
      if (!part) continue;
      if (!n.children) return null;
      const next = n.children.get(part.toUpperCase());
      if (!next) return null;
      n = next;
    }
    return n;
  }

  parentOf(path: string): { dir: VNode; name: string } | null {
    const f = this.full(path);
    if (!f) return null;
    const i = f.lastIndexOf("\\");
    const name = f.slice(i + 1);
    if (!name) return null;
    const dir = this.lookup(f.slice(0, i) || f.slice(0, 3));
    if (!dir || !dir.isDir) return null;
    return { dir, name };
  }

  mkdirp(path: string): VNode {
    const f = this.full(path)!;
    const d = this.drives.get(f[0]);
    if (!d) throw new Error(`no drive ${f[0]}`);
    let n = d.root;
    for (const part of f.slice(3).split("\\")) {
      if (!part) continue;
      let next = n.children!.get(part.toUpperCase());
      if (!next) {
        next = new VNode(part, true, n);
        n.children!.set(part.toUpperCase(), next);
      }
      n = next;
    }
    return n;
  }

  /** Adds (or replaces) a file. */
  addFile(path: string, src: FileSource, readonly = false): VNode {
    const f = this.full(path)!;
    const i = f.lastIndexOf("\\");
    const dir = this.mkdirp(f.slice(0, i) || f.slice(0, 3));
    const name = f.slice(i + 1);
    const node = new VNode(name, false, dir);
    node.src = src;
    node.readonly = readonly;
    dir.children!.set(name.toUpperCase(), node);
    return node;
  }

  create(path: string): VNode | null {
    const pd = this.parentOf(path);
    if (!pd) return null;
    const existing = pd.dir.children!.get(pd.name.toUpperCase());
    if (existing) {
      if (existing.isDir) return null;
      existing.truncate(0);
      return existing;
    }
    const node = new VNode(pd.name, false, pd.dir);
    node.data = new Uint8Array(64);
    node.size = 0;
    node.persist = true;
    pd.dir.children!.set(pd.name.toUpperCase(), node);
    return node;
  }

  remove(path: string): boolean {
    const n = this.lookup(path);
    if (!n || !n.parent) return false;
    if (n.isDir && n.children!.size) return false;
    n.parent.children!.delete(n.name.toUpperCase());
    this.persist?.remove(n.path());
    return true;
  }

  rename(from: string, to: string): boolean {
    const n = this.lookup(from);
    const pd = this.parentOf(to);
    if (!n || !n.parent || !pd || pd.dir.children!.has(pd.name.toUpperCase())) return false;
    n.parent.children!.delete(n.name.toUpperCase());
    this.persist?.remove(n.path());
    n.name = pd.name;
    n.parent = pd.dir;
    pd.dir.children!.set(pd.name.toUpperCase(), n);
    if (!n.isDir) this.flush(n);
    return true;
  }

  flush(n: VNode): void {
    if (!this.persist || n.isDir || !n.data) return;
    n.persist = true;
    this.persist.save(n.path(), n.data.subarray(0, n.size));
  }

  driveOf(path: string): DriveInfo | null {
    const f = this.full(path);
    return f ? this.drives.get(f[0])?.info ?? null : null;
  }

  /** Lists entries matching a DOS wildcard pattern like "C:\\DIR\\*.TXT". */
  find(pattern: string): VNode[] {
    const f = this.full(pattern);
    if (!f) return [];
    const i = f.lastIndexOf("\\");
    const dir = this.lookup(f.slice(0, i) || f.slice(0, 3));
    if (!dir || !dir.isDir) return [];
    const re = wildcard(f.slice(i + 1));
    const out: VNode[] = [];
    for (const c of dir.children!.values()) if (re.test(c.name)) out.push(c);
    return out;
  }
}

function wildcard(pat: string): RegExp {
  if (pat === "*.*" || pat === "*") return /^.*$/;
  let s = "^";
  for (const ch of pat) {
    if (ch === "*") s += ".*";
    else if (ch === "?") s += ".?";
    else s += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (pat.endsWith(".*")) s = s.slice(0, -4) + "(\\..*)?";
  return new RegExp(s + "$", "i");
}
