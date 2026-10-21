/** Minimal WebAssembly binary writer for the JIT. */

export const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c, V128 = 0x7b, FUNCREF = 0x70;
export const VOID = 0x40;

export const enum Op {
  unreachable = 0x00, nop = 0x01, block = 0x02, loop = 0x03, if_ = 0x04, else_ = 0x05, end = 0x0b, br = 0x0c, br_if = 0x0d,
  br_table = 0x0e, return_ = 0x0f, call = 0x10, call_indirect = 0x11, return_call = 0x12, return_call_indirect = 0x13,
  drop = 0x1a, select = 0x1b,
  local_get = 0x20, local_set = 0x21, local_tee = 0x22, global_get = 0x23, global_set = 0x24,
  i32_load = 0x28, i64_load = 0x29, f32_load = 0x2a, f64_load = 0x2b,
  i32_load8_s = 0x2c, i32_load8_u = 0x2d, i32_load16_s = 0x2e, i32_load16_u = 0x2f,
  i64_load8_s = 0x30, i64_load8_u = 0x31, i64_load16_s = 0x32, i64_load16_u = 0x33, i64_load32_s = 0x34, i64_load32_u = 0x35,
  i32_store = 0x36, i64_store = 0x37, f32_store = 0x38, f64_store = 0x39, i32_store8 = 0x3a, i32_store16 = 0x3b,
  i64_store8 = 0x3c, i64_store16 = 0x3d, i64_store32 = 0x3e,
  i32_const = 0x41, i64_const = 0x42, f32_const = 0x43, f64_const = 0x44,
  i32_eqz = 0x45, i32_eq = 0x46, i32_ne = 0x47, i32_lt_s = 0x48, i32_lt_u = 0x49, i32_gt_s = 0x4a, i32_gt_u = 0x4b,
  i32_le_s = 0x4c, i32_le_u = 0x4d, i32_ge_s = 0x4e, i32_ge_u = 0x4f,
  i64_eqz = 0x50, i64_eq = 0x51, i64_ne = 0x52, i64_lt_s = 0x53, i64_lt_u = 0x54, i64_gt_s = 0x55, i64_gt_u = 0x56,
  i64_le_s = 0x57, i64_le_u = 0x58, i64_ge_s = 0x59, i64_ge_u = 0x5a,
  f32_eq = 0x5b, f32_ne = 0x5c, f32_lt = 0x5d, f32_gt = 0x5e, f32_le = 0x5f, f32_ge = 0x60,
  f64_eq = 0x61, f64_ne = 0x62, f64_lt = 0x63, f64_gt = 0x64, f64_le = 0x65, f64_ge = 0x66,
  i32_clz = 0x67, i32_ctz = 0x68, i32_popcnt = 0x69, i32_add = 0x6a, i32_sub = 0x6b, i32_mul = 0x6c, i32_div_s = 0x6d,
  i32_div_u = 0x6e, i32_rem_s = 0x6f, i32_rem_u = 0x70, i32_and = 0x71, i32_or = 0x72, i32_xor = 0x73, i32_shl = 0x74,
  i32_shr_s = 0x75, i32_shr_u = 0x76, i32_rotl = 0x77, i32_rotr = 0x78,
  i64_clz = 0x79, i64_ctz = 0x7a, i64_popcnt = 0x7b, i64_add = 0x7c, i64_sub = 0x7d, i64_mul = 0x7e, i64_div_s = 0x7f,
  i64_div_u = 0x80, i64_rem_s = 0x81, i64_rem_u = 0x82, i64_and = 0x83, i64_or = 0x84, i64_xor = 0x85, i64_shl = 0x86,
  i64_shr_s = 0x87, i64_shr_u = 0x88, i64_rotl = 0x89, i64_rotr = 0x8a,
  f32_abs = 0x8b, f32_neg = 0x8c, f32_sqrt = 0x91, f32_add = 0x92, f32_sub = 0x93, f32_mul = 0x94, f32_div = 0x95,
  f64_abs = 0x99, f64_neg = 0x9a, f64_ceil = 0x9b, f64_floor = 0x9c, f64_trunc = 0x9d, f64_nearest = 0x9e, f64_sqrt = 0x9f,
  f64_add = 0xa0, f64_sub = 0xa1, f64_mul = 0xa2, f64_div = 0xa3, f64_min = 0xa4, f64_max = 0xa5, f64_copysign = 0xa6,
  i32_wrap_i64 = 0xa7, i32_trunc_f64_s = 0xaa, i64_extend_i32_s = 0xac, i64_extend_i32_u = 0xad, i64_trunc_f64_s = 0xb0,
  f32_demote_f64 = 0xb6, f64_convert_i32_s = 0xb7, f64_convert_i32_u = 0xb8, f64_convert_i64_s = 0xb9, f64_promote_f32 = 0xbb,
  i32_reinterpret_f32 = 0xbc, i64_reinterpret_f64 = 0xbd, f32_reinterpret_i32 = 0xbe, f64_reinterpret_i64 = 0xbf,
  i32_extend8_s = 0xc0, i32_extend16_s = 0xc1,
}

export class Bytes {
  buf = new Uint8Array(1024);
  len = 0;
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number): this {
    this.grow(1);
    this.buf[this.len++] = v;
    return this;
  }
  bytes(b: ArrayLike<number>): this {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  u32(v: number): this {
    v >>>= 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      this.u8(b);
    } while (v);
    return this;
  }
  s32(v: number): this {
    v |= 0;
    for (;;) {
      const b = v & 0x7f;
      v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }
  s64(v: bigint): this {
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40)) {
        this.u8(b);
        return this;
      }
      this.u8(b | 0x80);
    }
  }
  str(s: string): this {
    const e = new TextEncoder().encode(s);
    this.u32(e.length);
    return this.bytes(e);
  }
  section(id: number, body: Bytes): this {
    this.u8(id);
    this.u32(body.len);
    return this.bytes(body.buf.subarray(0, body.len));
  }
  get view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Function body builder. */
export class Code extends Bytes {
  private locals: number[] = [];
  constructor(readonly nparams: number) {
    super();
  }
  local(type: number): number {
    this.locals.push(type);
    return this.nparams + this.locals.length - 1;
  }
  op(o: Op): this {
    return this.u8(o);
  }
  get(i: number): this {
    return this.u8(Op.local_get).u32(i);
  }
  set(i: number): this {
    return this.u8(Op.local_set).u32(i);
  }
  tee(i: number): this {
    return this.u8(Op.local_tee).u32(i);
  }
  gget(i: number): this {
    return this.u8(Op.global_get).u32(i);
  }
  gset(i: number): this {
    return this.u8(Op.global_set).u32(i);
  }
  i32(v: number): this {
    return this.u8(Op.i32_const).s32(v);
  }
  i64(v: bigint): this {
    return this.u8(Op.i64_const).s64(v);
  }
  f64(v: number): this {
    this.u8(Op.f64_const);
    const b = new Uint8Array(new Float64Array([v]).buffer);
    return this.bytes(b);
  }
  mem(o: Op, offset = 0, align = 0): this {
    return this.u8(o).u32(align).u32(offset >>> 0);
  }
  fc(sub: number): this {
    return this.u8(0xfc).u32(sub);
  }
  simd(sub: number): this {
    return this.u8(0xfd).u32(sub);
  }
  simdMem(sub: number, offset = 0, align = 0): this {
    return this.simd(sub).u32(align).u32(offset >>> 0);
  }
  call(f: number): this {
    return this.u8(Op.call).u32(f);
  }
  br(depth: number): this {
    return this.u8(Op.br).u32(depth);
  }
  brIf(depth: number): this {
    return this.u8(Op.br_if).u32(depth);
  }
  block(type = VOID): this {
    return this.u8(Op.block).u8(type);
  }
  loop(type = VOID): this {
    return this.u8(Op.loop).u8(type);
  }
  if_(type = VOID): this {
    return this.u8(Op.if_).u8(type);
  }
  else_(): this {
    return this.u8(Op.else_);
  }
  end(): this {
    return this.u8(Op.end);
  }
  /** Serialized body including locals and the final `end`. */
  finish(): Uint8Array {
    const out = new Bytes();
    const groups: [number, number][] = [];
    for (const t of this.locals) {
      const g = groups[groups.length - 1];
      if (g && g[1] === t) g[0]++;
      else groups.push([1, t]);
    }
    out.u32(groups.length);
    for (const [n, t] of groups) out.u32(n).u8(t);
    out.bytes(this.view);
    out.u8(Op.end);
    const sized = new Bytes();
    sized.u32(out.len).bytes(out.view);
    return sized.view.slice();
  }
}

interface FuncType {
  params: number[];
  results: number[];
}

/** Module builder: imports a memory, optional table, globals and functions; defines functions. */
export class ModuleBuilder {
  private types: FuncType[] = [];
  private imports: Bytes[] = [];
  private nImportFuncs = 0;
  private nImportGlobals = 0;
  private funcs: { type: number; body: Uint8Array }[] = [];
  private exports: [string, number, number][] = [];

  type(params: number[], results: number[]): number {
    const k = this.types.findIndex((t) => t.params.join() === params.join() && t.results.join() === results.join());
    if (k >= 0) return k;
    this.types.push({ params, results });
    return this.types.length - 1;
  }

  importMemory(mod: string, name: string, pages: number): void {
    const b = new Bytes().str(mod).str(name).u8(2).u8(1).u32(pages).u32(pages);
    this.imports.push(b);
  }

  importTable(mod: string, name: string, min: number): void {
    this.imports.push(new Bytes().str(mod).str(name).u8(1).u8(FUNCREF).u8(0).u32(min));
  }

  importGlobal(mod: string, name: string, type: number, mutable: boolean): number {
    this.imports.push(new Bytes().str(mod).str(name).u8(3).u8(type).u8(mutable ? 1 : 0));
    return this.nImportGlobals++;
  }

  importFunc(mod: string, name: string, params: number[], results: number[]): number {
    if (this.funcs.length) throw new Error("imports must precede definitions");
    const t = this.type(params, results);
    this.imports.push(new Bytes().str(mod).str(name).u8(0).u32(t));
    return this.nImportFuncs++;
  }

  /** Index the next defined function will get. */
  get nextFunc(): number {
    return this.nImportFuncs + this.funcs.length;
  }

  func(params: number[], results: number[], body: Uint8Array): number {
    this.funcs.push({ type: this.type(params, results), body });
    return this.nImportFuncs + this.funcs.length - 1;
  }

  exportFunc(name: string, index: number): void {
    this.exports.push([name, 0, index]);
  }

  build(): Uint8Array {
    const out = new Bytes().bytes([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const ts = new Bytes().u32(this.types.length);
    for (const t of this.types) {
      ts.u8(0x60).u32(t.params.length).bytes(t.params).u32(t.results.length).bytes(t.results);
    }
    out.section(1, ts);
    const is = new Bytes().u32(this.imports.length);
    for (const i of this.imports) is.bytes(i.view);
    out.section(2, is);
    const fs = new Bytes().u32(this.funcs.length);
    for (const f of this.funcs) fs.u32(f.type);
    out.section(3, fs);
    const es = new Bytes().u32(this.exports.length);
    for (const [n, k, i] of this.exports) es.str(n).u8(k).u32(i);
    out.section(7, es);
    const cs = new Bytes().u32(this.funcs.length);
    for (const f of this.funcs) cs.bytes(f.body);
    out.section(10, cs);
    return out.view.slice();
  }
}
