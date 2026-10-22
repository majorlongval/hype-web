/** Parses the disc's Ubi Soft installer script (InstData/ubi.ins) into a file copy plan. */
export interface InstallFile {
  src: string;
  dst: string;
}
export interface InstallPlan {
  appName: string;
  volumeName: string;
  defaultPath: string;
  program: string;
  files: InstallFile[];
  iniKeys: [string, string][];
  languages: string[];
}

/** Retail CDs store their installer script in ubiins.dat; mirror its full install layout. */
export function planRetailInstall(paths: string[], language = "English"): InstallPlan {
  const languages = [...new Set(paths.flatMap((p) => /^LangData\\([^\\]+)\\/i.exec(p)?.[1] ?? []))];
  const selected = languages.find((l) => l.toLowerCase() === language.toLowerCase());
  if (!selected) throw new Error(`Language ${language} is unavailable on this disc (available: ${languages.join(", ")}).`);
  const files: InstallFile[] = [];
  const add = (src: string, dst: string) => files.push({ src, dst });
  for (const src of paths) {
    if (/^GameData\\/i.test(src)) add(src, src);
    else if (src.toLowerCase().startsWith(`langdata\\${selected.toLowerCase()}\\`)) {
      add(src, `GameData\\${src.split("\\").slice(2).join("\\")}`);
    } else if (/^(Sound|DLL)\\/i.test(src)) add(src, src);
    else if (/^exe\\(DLL MFC|Glide 3x|UbiConfig|VidSelect)\\[^\\]+$/i.test(src) && !/\.icd$/i.test(src)) {
      add(src, src.split("\\").at(-1)!);
    } else if (/^exe\\GLI\.ini$/i.test(src)) add(src, "GLI.ini");
  }
  if (!files.some((f) => f.dst.toUpperCase() === "MAIDFXVR_BLEU.EXE")) {
    throw new Error("The full disc is missing exe\\Glide 3x\\MaiDFXvr_bleu.exe.");
  }
  return { appName: "Hype - The Time Quest", volumeName: "HYPE", defaultPath: "\\UbiSoft\\Hype",
    program: "MaiDFXvr_bleu.exe", files, iniKeys: [], languages };
}

function sectionLines(lines: string[], start: number, endTag: string): [string[], number] {
  const out: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.toUpperCase() === endTag) break;
    if (t.startsWith("[") && endTag === "") break;
    if (t && !t.startsWith("//")) out.push(t);
  }
  return [out, i];
}

function fileLine(t: string): InstallFile | null {
  const parts = t.split(",");
  if (parts.length < 3) return null;
  const [name, srcDir, dstDir] = parts.map((s) => s.trim());
  const clean = (d: string) => d.replace(/^\\+/, "").replace(/\\+$/, "");
  const src = [clean(srcDir), name].filter(Boolean).join("\\");
  const dst = [clean(dstDir), name].filter(Boolean).join("\\");
  return { src, dst };
}

export function planInstall(ins: string, language = "English", wantGlide = true): InstallPlan {
  const lines = ins.split(/\r?\n/);
  const plan: InstallPlan = { appName: "Hype - The Time Quest", volumeName: "", defaultPath: "\\UbiSoft\\Hype", program: "",
    files: [], iniKeys: [], languages: [] };
  const single = (i: number) => {
    for (let k = i + 1; k < lines.length; k++) if (lines[k].trim()) return lines[k].trim();
    return "";
  };
  let configStart = -1, configEnd = -1;
  const configs: [number, number, string][] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const u = t.toUpperCase();
    if (u === "[APPLICATION NAME]") plan.appName = single(i);
    else if (u === "[VOLUME NAME]") plan.volumeName = single(i);
    else if (u === "[DEFAULT PATH]") plan.defaultPath = single(i);
    else if (u === "[COMMON FILES]") {
      const [ls, end] = sectionLines(lines, i + 1, "[END COMMON FILES]");
      for (const l of ls) { const f = fileLine(l); if (f) plan.files.push(f); }
      i = end;
    } else if (u === "[LANGUAGE FILES]") {
      const [ls, end] = sectionLines(lines, i + 1, "[END LANGUAGE FILES]");
      let cur = "";
      for (const l of ls) {
        const m = /^Language\s*,\s*(.+)$/i.exec(l);
        if (m) { cur = m[1].trim(); plan.languages.push(cur); continue; }
        if (cur.toLowerCase() === language.toLowerCase()) { const f = fileLine(l); if (f) plan.files.push(f); }
      }
      i = end;
    } else if (u.startsWith("CONFIG ")) {
      const title = t.slice(7);
      let k = i + 1;
      while (k < lines.length && !lines[k].trim().toUpperCase().startsWith("END CONFIG")) k++;
      configs.push([i, k, title]);
      i = k;
    }
  }
  const pick = configs.find((c) => /glide|3dfx/i.test(c[2]) === wantGlide) ?? configs[0];
  if (pick) [configStart, configEnd] = pick;
  for (let i = configStart + 1; i > 0 && i < configEnd; i++) {
    const u = lines[i].trim().toUpperCase();
    if (u === "[SPECIFIC FILES]" || u === "[LANGUAGE SPECIFIC FILES]") {
      const [ls, end] = sectionLines(lines, i + 1, u.replace("[", "[END "));
      for (const l of ls) { const f = fileLine(l); if (f) plan.files.push(f); }
      i = end;
    } else if (u === "[PROGRAM NAME]") plan.program = single(i);
    else if (u === "[INI SECTIONS]") {
      const [ls, end] = sectionLines(lines, i + 1, "[END INI SECTIONS]");
      for (const l of ls) {
        const c = l.indexOf(",");
        if (c > 0) plan.iniKeys.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
      }
      i = end;
    }
  }
  return plan;
}

export function ubiIni(plan: InstallPlan, installDir: string, language: string): string {
  const keys: [string, string][] = [
    ["PlayVideo", "1"], ["SoundStream", "1"], ["SoundOnHD", "1"], ["MaxRAMForAGP", "AUTO"], ["MipMapping", "AUTO"],
    ["LowGraphicMode", "0"], ["ChangeMapMusic", "0"], ["Complete", "1"], ["ExecutableType", "3DFX"],
    ["ForceVideoMode", "DXMedia"], ["Language", language], ["Configuration", "0"], ["VolumeName", plan.volumeName || "Hype"],
    ["SrcDataPath", `${installDir}\\GameData\\`], ["Directory", `${installDir}\\`],
  ];
  for (const [k, v] of plan.iniKeys) {
    const i = keys.findIndex(([kk]) => kk.toLowerCase() === k.toLowerCase());
    if (i >= 0) keys[i][1] = v;
    else keys.push([k, v]);
  }
  const body = keys.map(([k, v]) => `${k}=${v}`).join("\r\n");
  return `[SYSTEM]\r\nMemory=255\r\nMMX=1\r\nWindows colors=34\r\n\r\n[INSTALLED PRODUCTS]\r\n${plan.appName}\r\n\r\n[${plan.appName}]\r\n${body}\r\n\r\n[OSD]\r\nValid=TRUE\r\n`;
}
