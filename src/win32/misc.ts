import type { Machine } from "./machine";

export function registerMisc(m0: Machine): void {
  // Retail imports these optional Windows components; unused exports remain strict missing-API thunks.
  for (const dll of ["shell32.dll", "ole32.dll", "oleaut32.dll", "ddraw.dll", "quartz.dll"]) m0.register(dll, {});
  m0.register("ole32.dll", {
    CoInitialize: [4, () => 0],
    CoUninitialize: [0, () => {}],
    OleInitialize: [4, () => 0],
    OleUninitialize: [0, () => {}],
  });
  m0.register("msvfw32.dll", {
    MCIWndCreateA: [0, (m, a) => {
      m.log(`MCIWndCreate(${a.str(3)}) -> NULL (video not supported yet)`);
      return 0;
    }],
  });
  m0.register("msacm32.dll", {
    acmDriverEnum: [12, () => 0],
    acmDriverOpen: [12, () => 0x200],
    acmDriverClose: [8, () => 0],
    acmDriverDetailsA: [12, () => 0x200],
    acmFormatTagDetailsA: [12, () => 0x200],
    acmFormatSuggest: [20, () => 0x200],
    acmStreamOpen: [32, () => 0x200],
    acmStreamClose: [8, () => 0],
    acmStreamSize: [16, () => 0x200],
    acmStreamPrepareHeader: [12, () => 0x200],
    acmStreamUnprepareHeader: [12, () => 0x200],
    acmStreamConvert: [12, () => 0x200],
    acmMetrics: [12, () => 0x200],
  });
  m0.register("dsound.dll", {
    DirectSoundCreate: [12, (m) => { m.log("DirectSoundCreate -> DSERR_NODRIVER"); return 0x88780078; }],
    DirectSoundEnumerateA: [8, () => 0],
  }, { 1: "DirectSoundCreate", 2: "DirectSoundEnumerateA" });
  m0.register("advapi32.dll", {
    RegOpenKeyExA: [20, () => 2],
    RegOpenKeyA: [12, () => 2],
    RegCreateKeyExA: [36, () => 2],
    RegQueryValueExA: [24, () => 2],
    RegCloseKey: [4, () => 0],
    RegSetValueExA: [24, () => 0],
    GetUserNameA: [8, (m, a) => { m.mem.writeCString(a.u(0), "Player"); return 1; }],
  });
}
