/** Byte offsets of CPU state inside the wasm memory, relative to Memory.stateBase. */
export const ST_REGS = 0;
export const ST_FLAGS = 32;
export const ST_LFOP = 36;
export const ST_LFA = 40;
export const ST_LFB = 44;
export const ST_LFRES = 48;
export const ST_LFSZ = 52;
export const ST_LFCIN = 56;
export const ST_LFOF = 60;
export const ST_SEGBASE = 64;
export const ST_FPU_TOP = 96;
export const ST_FPU_CW = 100;
export const ST_FPU_SW = 104;
export const ST_FPU_EMPTY = 120;
export const ST_FPU_ST = 128;
export const ST_MMX = 192;
export const STATE_BYTES = 264;

/** Scratch area after the per-thread state (JIT globals, temporaries). Not saved per thread. */
export const ST_SCRATCH = 512;
export const ST_JIT_BUDGET = ST_SCRATCH, ST_JIT_RESUME = ST_SCRATCH + 4, ST_JIT_FORCE = ST_SCRATCH + 8;

export function initState(u8: Uint8Array, off: number): void {
  const dv = new DataView(u8.buffer, u8.byteOffset + off, STATE_BYTES);
  for (let i = 0; i < STATE_BYTES; i++) dv.setUint8(i, 0);
  dv.setUint32(ST_FLAGS, 0x202, true);
  dv.setUint32(ST_LFSZ, 4, true);
  dv.setUint32(ST_FPU_CW, 0x037f, true);
  for (let i = 0; i < 8; i++) dv.setUint8(ST_FPU_EMPTY + i, 1);
}
