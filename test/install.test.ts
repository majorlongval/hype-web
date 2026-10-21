import { describe, expect, it } from "vitest";
import { planRetailInstall, ubiIni } from "../src/install";
import { readInstallPlan, type Disc } from "../src/boot";
import { MemSource } from "../src/win32/vfs";

const files = [
  "InstData\\ubiins.dat", "exe\\Glide 3x\\MAIDFXVR_BLEU.EXE", "exe\\Glide 3x\\MAIDFXVR_BLEU.ICD",
  "exe\\DLL MFC\\Mfc42.dll", "exe\\DLL MFC\\Msvcrt.dll", "exe\\GLI.ini",
  "DLL\\WAVMWBVR.DLL", "Sound\\themes.csb", "Gamedata\\World\\Levels\\tower\\tower.sna",
  "LangData\\English\\world\\levels\\tower\\tower.lng", "LangData\\French\\world\\levels\\tower\\tower.lng",
  "Gamedata\\Videos\\HypeIntro.avi",
];

describe("retail installation", () => {
  it("merges the selected language with level data and installs runtime libraries", () => {
    const plan = planRetailInstall(files);
    expect(plan.program).toBe("MaiDFXvr_bleu.exe");
    expect(plan.files).toContainEqual({ src: files[9], dst: "GameData\\world\\levels\\tower\\tower.lng" });
    expect(plan.files).toContainEqual({ src: files[8], dst: files[8] });
    expect(plan.files).toContainEqual({ src: files[3], dst: "Mfc42.dll" });
    expect(plan.files).toContainEqual({ src: files[6], dst: files[6] });
    expect(plan.files).toContainEqual({ src: files[1], dst: "MAIDFXVR_BLEU.EXE" });
    expect(plan.files.some((f) => /French|\.ICD$/i.test(f.src))).toBe(false);
    expect(ubiIni(plan, "C:\\UbiSoft\\Hype", "English")).toContain("PlayVideo=0");
  });

  it("selects languages case-insensitively and rejects unavailable languages", () => {
    expect(planRetailInstall(files, "french").files).toContainEqual({ src: files[10], dst: "GameData\\world\\levels\\tower\\tower.lng" });
    expect(() => planRetailInstall(files, "Spanish")).toThrow("unavailable");
    expect(() => planRetailInstall(files.filter((p) => !p.endsWith(".EXE")))).toThrow("missing");
  });

  it("accepts a replacement executable and reports a protected launcher", () => {
    const disc = (size: number): Disc => ({ label: "HYPE", paths: () => files,
      open: () => new MemSource(new Uint8Array(size)) });
    expect(() => readInstallPlan(disc(280311))).toThrow("SafeDisc launcher");
    expect(readInstallPlan(disc(2299437)).program).toBe("MaiDFXvr_bleu.exe");
  });

  it("continues to read demo installer scripts", () => {
    const ins = "[APPLICATION NAME]\nHype Demo\n[DEFAULT PATH]\n\\UbiSoft\\HypeDemo\nCONFIG Glide\n[PROGRAM NAME]\nMaiDFXvr_bleu.exe\nEND CONFIG";
    const disc: Disc = { label: "DEMO", paths: () => ["InstData\\ubi.ins"],
      open: () => new MemSource(new TextEncoder().encode(ins)) };
    expect(readInstallPlan(disc).appName).toBe("Hype Demo");
  });
});
