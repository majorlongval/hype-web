import { Machine, type Host, type GuestModule } from "./win32/machine";
import { VFS, MemSource, DRIVE_CDROM, DRIVE_FIXED, type FileSource, type PersistStore } from "./win32/vfs";
import { registerKernel32, setupProcess, latin1 } from "./win32/kernel32";
import { registerUser32 } from "./win32/user32";
import { registerGdi32 } from "./win32/gdi32";
import { registerWinmm } from "./win32/winmm";
import { registerDinput } from "./win32/dinput";
import { registerGlide3x } from "./win32/glide3x";
import { registerAvifile } from "./win32/avifile";
import { registerMisc } from "./win32/misc";
import { planInstall, ubiIni, type InstallPlan } from "./install";
import type { HleGen } from "./win32/thread";

/** The player's game disc: a flat list of files addressed by relative path ("GameData\\Textures.cnt"). */
const HYPE_CD_LABEL = "HYPE";

export interface Disc {
  label: string;
  paths(): string[];
  open(path: string): FileSource;
}

export interface BootOptions {
  disc: Disc;
  host: Host;
  language?: string;
  persist?: PersistStore;
  /** Files written in earlier sessions (save games, settings), keyed by full guest path. */
  saved?: Map<string, Uint8Array>;
  installDir?: string;
}

export interface Booted {
  m: Machine;
  plan: InstallPlan;
  exe: GuestModule;
}

export function readInstallPlan(disc: Disc, language = "English"): InstallPlan {
  const insPath = disc.paths().find((p) => p.toUpperCase() === "INSTDATA\\UBI.INS");
  if (!insPath) throw new Error("This doesn't look like a Hype disc: InstData\\ubi.ins is missing.");
  const insSrc = disc.open(insPath);
  const insBuf = new Uint8Array(insSrc.size);
  insSrc.read(0, insBuf, 0, insBuf.length);
  return planInstall(String.fromCharCode(...insBuf), language, true);
}

export function bootGame(o: BootOptions): Booted {
  const byUpper = new Map<string, string>();
  for (const p of o.disc.paths()) byUpper.set(p.toUpperCase(), p);
  const language = o.language ?? "English";
  const plan = readInstallPlan(o.disc, language);

  const vfs = new VFS();
  vfs.addDrive({ letter: "C", type: DRIVE_FIXED, label: "SYSTEM", serial: 0x1234abcd, fs: "FAT32" });
  vfs.addDrive({ letter: "D", type: DRIVE_CDROM, label: o.disc.label || HYPE_CD_LABEL, serial: 0x0ce0beef, fs: "CDFS" });
  for (const p of byUpper.values()) vfs.addFile(`D:\\${p}`, o.disc.open(p), true);
  vfs.mkdirp("C:\\WINDOWS\\SYSTEM");
  vfs.mkdirp("C:\\WINDOWS\\TEMP");
  const installDir = o.installDir ?? `C:${plan.defaultPath.startsWith("\\") ? "" : "\\"}${plan.defaultPath}`;
  for (const f of plan.files) {
    const src = byUpper.get(f.src.toUpperCase());
    if (!src) {
      o.host.log(`install: missing on disc ${f.src}`);
      continue;
    }
    vfs.addFile(`${installDir}\\${f.dst}`, o.disc.open(src), false);
  }
  vfs.mkdirp(`${installDir}\\GameData\\SaveGame`);
  const ini = latin1(ubiIni(plan, installDir, language));
  vfs.addFile("C:\\WINDOWS\\Ubisoft\\ubi.ini", new MemSource(ini));
  vfs.addFile(`${installDir}\\Ubisoft\\ubi.ini`, new MemSource(ini));
  for (const [path, data] of o.saved ?? []) vfs.addFile(path, new MemSource(data)).persist = true;
  vfs.persist = o.persist ?? null;
  vfs.cwd = installDir;

  const m = new Machine(vfs, o.host);
  registerKernel32(m);
  registerUser32(m);
  registerGdi32(m);
  registerWinmm(m);
  registerDinput(m);
  registerGlide3x(m);
  registerMisc(m);
  registerAvifile(m);

  const exePath = `${installDir}\\${plan.program}`;
  setupProcess(m, `"${exePath}"`, {
    PATH: "C:\\WINDOWS;C:\\WINDOWS\\SYSTEM", TEMP: "C:\\WINDOWS\\TEMP", TMP: "C:\\WINDOWS\\TEMP", windir: "C:\\WINDOWS",
    COMSPEC: "C:\\WINDOWS\\COMMAND.COM",
  });
  const pending: GuestModule[] = [];
  const exe = m.loadImage(exePath, pending);
  m.exe = exe;
  const main = m.createThread(exe.pe!.stackReserve || 0x100000, 0, 0, (function* (): HleGen {
    for (const d of pending) {
      if (!d.entry || d.attached) continue;
      d.attached = true;
      const ok = yield { t: "call", addr: d.entry, args: [d.base, 1, 0] };
      if (!ok) m.log(`DllMain(${d.name}) returned FALSE`);
    }
    const r = yield { t: "call", addr: exe.entry, args: [] };
    m.exitProcess(r);
    return r;
  })());
  main.label = "main";
  return { m, plan, exe };
}
