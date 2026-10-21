import type { Machine } from "./machine";

const AVIERR_FILEOPEN = 0x80044067;

export function registerMisc(m0: Machine): void {
  m0.register("avifil32.dll", {
    AVIFileInit: [0, () => {}],
    AVIFileExit: [0, () => {}],
    AVIFileOpenA: [16, (m, a) => {
      m.log(`AVIFileOpen(${a.str(1)}) -> not supported yet`);
      m.mem.dv.setUint32(a.u(0), 0, true);
      return AVIERR_FILEOPEN;
    }],
    AVIFileRelease: [4, () => 0],
    AVIFileInfoA: [12, () => AVIERR_FILEOPEN],
    AVIFileGetStream: [16, () => AVIERR_FILEOPEN],
    AVIStreamRelease: [4, () => 0],
    AVIStreamInfoA: [12, () => AVIERR_FILEOPEN],
    AVIStreamReadFormat: [16, () => AVIERR_FILEOPEN],
    AVIStreamRead: [28, () => AVIERR_FILEOPEN],
    AVIStreamGetFrameOpen: [8, () => 0],
    AVIStreamGetFrame: [8, () => 0],
    AVIStreamGetFrameClose: [4, () => 0],
  });
  m0.register("msvfw32.dll", {
    MCIWndCreateA: [16, (m, a) => {
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
