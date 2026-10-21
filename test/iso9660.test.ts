import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { IsoFileSource, readIso } from "../src/media/iso9660";
import { MemSource } from "../src/win32/vfs";

const DEMO = join(import.meta.dirname, "../_untrusted/demo/HypeDemo/hype");
const hasTools = (() => {
  try {
    execFileSync("xorrisofs", ["-version"], { stdio: "ignore" });
    return existsSync(DEMO);
  } catch {
    return false;
  }
})();

let dir: string;

function listFiles(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(root, r) : [r];
  });
}

function makeIso(name: string, src: string, args: string[]): MemSource {
  const out = join(dir, name);
  execFileSync("xorrisofs", ["-quiet", ...args, "-o", out, src]);
  return new MemSource(readFileSync(out));
}

function readAll(image: MemSource, f: { lba: number; size: number; path: string }): Buffer {
  const src = new IsoFileSource(image, f);
  const buf = new Uint8Array(src.size);
  expect(src.read(0, buf, 0, buf.length)).toBe(buf.length);
  return Buffer.from(buf);
}

describe.skipIf(!hasTools)("readIso", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hype-iso-"));
  });

  it("reads a Joliet image of the demo disc with long names, label and contents", () => {
    const image = makeIso("joliet.iso", DEMO, ["-J", "-joliet-long", "-V", "HYPE"]);
    const iso = readIso(image);

    expect(iso.label).toBe("HYPE");

    const expected = listFiles(DEMO).map((p) => p.replaceAll("/", "\\")).sort();
    expect(iso.files.map((f) => f.path).sort()).toEqual(expected);

    for (const f of iso.files) expect(f.size).toBe(statSync(join(DEMO, f.path.replaceAll("\\", "/"))).size);

    const ins = iso.files.find((f) => f.path === "InstData\\ubi.ins")!;
    expect(readAll(image, ins).equals(readFileSync(join(DEMO, "InstData/ubi.ins")))).toBe(true);
  });

  it("falls back to the primary ISO 9660 tree when there is no Joliet", () => {
    const src = join(dir, "plain");
    mkdirSync(join(src, "DATA"), { recursive: true });
    writeFileSync(join(src, "README.TXT"), "hello");
    writeFileSync(join(src, "DATA", "NOEXT"), Buffer.alloc(5000, 7));
    const image = makeIso("plain.iso", src, ["-V", "PLAIN"]);
    const iso = readIso(image);

    expect(iso.label).toBe("PLAIN");
    expect(iso.files.map((f) => f.path).sort()).toEqual(["DATA\\NOEXT", "README.TXT"]);
    expect(readAll(image, iso.files.find((f) => f.path === "DATA\\NOEXT")!).equals(Buffer.alloc(5000, 7))).toBe(true);
  });

  it("rejects something that isn't a disc image", () => {
    expect(() => readIso(new MemSource(new Uint8Array(40 * 2048)))).toThrow(/ISO 9660/);
  });
});
