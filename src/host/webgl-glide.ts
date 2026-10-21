import {
  VF, LFB_UNTOUCHED16, LFB_UNTOUCHED32, lodDims, texelBytes, type Glide, type GlideBackend, type GlideState, type TexDesc,
} from "../win32/glide3x";

const MAX_VERTS = 1 << 16;

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_pos;
layout(location = 1) in vec4 a_col;
layout(location = 2) in vec3 a_tex;
layout(location = 3) in float a_fog;
uniform vec2 u_screen;
uniform float u_pointSize;
out vec4 v_col;
out vec3 v_tex;
out vec2 v_zf;
void main() {
  float oow = a_pos.w > 0.0 ? a_pos.w : 1.0;
  float w = 1.0 / oow;
  vec2 ndc = vec2(a_pos.x / u_screen.x * 2.0 - 1.0, 1.0 - a_pos.y / u_screen.y * 2.0);
  gl_Position = vec4(ndc * w, 0.0, w);
  gl_PointSize = u_pointSize;
  v_col = a_col * (w / 255.0);
  v_tex = a_tex * w;
  v_zf = vec2(a_pos.z, a_fog) * w;
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 v_col;
in vec3 v_tex;
in vec2 v_zf;
uniform sampler2D u_tex;
uniform sampler2D u_fogTex;
uniform bool u_texOn;
uniform vec2 u_texScale;
uniform ivec4 u_cc;
uniform ivec4 u_ac;
uniform ivec4 u_tc;
uniform ivec4 u_inv;
uniform vec4 u_const;
uniform int u_alphaFunc;
uniform float u_alphaRef;
uniform int u_depthMode;
uniform float u_bias;
uniform int u_fogMode;
uniform vec3 u_fogColor;
uniform bool u_chroma;
uniform vec3 u_chromaKey;
out vec4 o;

vec3 combineRGB(int fn, vec3 f, vec3 local, float localA, vec3 other) {
  if (fn == 0) return vec3(0.0);
  if (fn == 1) return local;
  if (fn == 2) return vec3(localA);
  if (fn == 3) return f * other;
  if (fn == 4) return f * other + local;
  if (fn == 5) return f * other + localA;
  if (fn == 6) return f * (other - local);
  if (fn == 7) return f * (other - local) + local;
  if (fn == 8) return f * (other - local) + localA;
  if (fn == 9) return local - f * local;
  return localA - f * local;
}

float combineA(int fn, float f, float local, float other) {
  if (fn == 0) return 0.0;
  if (fn == 1 || fn == 2) return local;
  if (fn == 3) return f * other;
  if (fn == 4 || fn == 5) return f * other + local;
  if (fn == 6) return f * (other - local);
  if (fn == 7 || fn == 8) return f * (other - local) + local;
  return local - f * local;
}

vec3 ccFactor(int k, vec3 cl, float al, float ao, vec4 t) {
  if (k == 1) return cl;
  if (k == 2) return vec3(ao);
  if (k == 3) return vec3(al);
  if (k == 4) return vec3(t.a);
  if (k == 5) return t.rgb;
  if (k == 8) return vec3(1.0);
  if (k == 9) return 1.0 - cl;
  if (k == 10) return vec3(1.0 - ao);
  if (k == 11) return vec3(1.0 - al);
  if (k == 12) return vec3(1.0 - t.a);
  if (k == 13) return 1.0 - t.rgb;
  return vec3(0.0);
}

float acFactor(int k, float al, float ao, float ta) {
  if (k == 1 || k == 3) return al;
  if (k == 2) return ao;
  if (k == 4) return ta;
  if (k == 8 || k == 13) return 1.0;
  if (k == 9 || k == 11) return 1.0 - al;
  if (k == 10) return 1.0 - ao;
  if (k == 12) return 1.0 - ta;
  return 0.0;
}

vec3 tcFactorRGB(int k, vec4 t) {
  if (k == 1) return t.rgb;
  if (k == 3) return vec3(t.a);
  if (k == 8 || k == 10 || k == 12 || k == 13) return vec3(1.0);
  if (k == 9) return 1.0 - t.rgb;
  if (k == 11) return vec3(1.0 - t.a);
  return vec3(0.0);
}

float tcFactorA(int k, vec4 t) {
  if (k == 1 || k == 3) return t.a;
  if (k == 8 || k == 10 || k == 12 || k == 13) return 1.0;
  if (k == 9 || k == 11) return 1.0 - t.a;
  return 0.0;
}

bool cmp(int fn, float a, float b) {
  if (fn == 0) return false;
  if (fn == 1) return a < b;
  if (fn == 2) return a == b;
  if (fn == 3) return a <= b;
  if (fn == 4) return a > b;
  if (fn == 5) return a != b;
  if (fn == 6) return a >= b;
  return true;
}

float fogLookup(float w) {
  float u = clamp(log2(max(w, 1.0)) / 16.0, 0.0, 1.0);
  return texture(u_fogTex, vec2(u * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).r;
}

void main() {
  float oow = gl_FragCoord.w;
  vec4 iter = clamp(v_col * oow, 0.0, 1.0);
  float depth;
  if (u_depthMode == 2 || u_depthMode == 4) depth = clamp((log2(1.0 / oow) + 12.0) / 30.0, 0.0, 1.0);
  else depth = clamp(v_zf.x * oow / 65535.0, 0.0, 1.0);

  vec4 tex = vec4(1.0);
  if (u_texOn) {
    vec4 t = texture(u_tex, (v_tex.xy / v_tex.z) / u_texScale);
    vec3 tr = combineRGB(u_tc.x, tcFactorRGB(u_tc.y, t), t.rgb, t.a, vec3(0.0));
    float ta = combineA(u_tc.z, tcFactorA(u_tc.w, t), t.a, 0.0);
    if (u_inv.z != 0) tr = 1.0 - tr;
    if (u_inv.w != 0) ta = 1.0 - ta;
    tex = clamp(vec4(tr, ta), 0.0, 1.0);
  }

  vec3 cl = u_cc.z == 0 ? iter.rgb : (u_cc.z == 1 ? u_const.rgb : vec3(depth));
  vec3 co = u_cc.w == 0 ? iter.rgb : (u_cc.w == 1 ? tex.rgb : u_const.rgb);
  float al = u_ac.z == 0 ? iter.a : (u_ac.z == 1 ? u_const.a : depth);
  float ao = u_ac.w == 0 ? iter.a : (u_ac.w == 1 ? tex.a : u_const.a);
  if (u_chroma && all(lessThan(abs(floor(co * 255.0 + 0.5) - u_chromaKey), vec3(0.5)))) discard;

  vec3 c = combineRGB(u_cc.x, ccFactor(u_cc.y, cl, al, ao, tex), cl, al, co);
  float a = combineA(u_ac.x, acFactor(u_ac.y, al, ao, tex.a), al, ao);
  if (u_inv.x != 0) c = 1.0 - c;
  if (u_inv.y != 0) a = 1.0 - a;
  c = clamp(c, 0.0, 1.0);
  a = clamp(a, 0.0, 1.0);
  if (!cmp(u_alphaFunc, floor(a * 255.0 + 0.5), u_alphaRef)) discard;

  int fm = u_fogMode & 0xff;
  if (fm != 0) {
    float f;
    if (fm == 1) f = fogLookup(v_zf.y * oow);
    else if (fm == 2) f = fogLookup(1.0 / oow);
    else if (fm == 3) f = depth;
    else f = iter.a;
    if ((u_fogMode & 0x100) != 0) c = f * u_fogColor;
    else if ((u_fogMode & 0x200) != 0) c = (1.0 - f) * c;
    else c = mix(c, u_fogColor, f);
  }
  o = vec4(c, a);
  gl_FragDepth = clamp(depth + u_bias, 0.0, 1.0);
}`;

const LFB_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec4 u_rect;
uniform vec2 u_screen;
out vec2 v_uv;
void main() {
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  v_uv = a_pos;
  gl_Position = vec4(p.x / u_screen.x * 2.0 - 1.0, 1.0 - p.y / u_screen.y * 2.0, 0.0, 1.0);
}`;

const LFB_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_img;
out vec4 o;
void main() {
  vec4 c = texture(u_img, v_uv);
  if (c.a < 0.5) discard;
  o = c;
}`;

interface CachedTex {
  tex: WebGLTexture;
  start: number;
  end: number;
  levels: number;
}

interface Target {
  fb: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

const BLEND_SRC = [0, 0x302, 0x306, 0x304, 1, 0x303, 0x307, 0x305];
const BLEND_DST = [0, 0x302, 0x300, 0x304, 1, 0x303, 0x301, 0x305];

function blendFactor(v: number, src: boolean): number {
  if (v === 0xf) return src ? 0x308 : 1;
  return (src ? BLEND_SRC : BLEND_DST)[v] ?? 1;
}

const expand5 = (v: number) => (v << 3) | (v >> 2);
const expand6 = (v: number) => (v << 2) | (v >> 4);
const expand4 = (v: number) => v * 17;

function fogIndexToW(i: number): number {
  return Math.pow(2, 3 + (i >> 2)) / (8 - (i & 3));
}

export class WebGLGlide implements GlideBackend {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private lfbProg: WebGLProgram;
  private lu: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject;
  private staging = new Float32Array(MAX_VERTS * VF);
  private count = 0;
  private batchMode: "tri" | "line" | "point" = "tri";
  private batchVersion = -1;
  private targets: Target[] = [];
  private back = 0;
  private width = 640;
  private height = 480;
  private fbW = 640;
  private fbH = 480;
  private texCache = new Map<string, CachedTex>();
  private palette = new Uint32Array(256);
  private palHash = 0;
  private fogTex: WebGLTexture;
  private fogSrc: Uint8Array | null = null;
  private lfbTex: WebGLTexture;
  private readTarget: { fb: WebGLFramebuffer; rb: WebGLRenderbuffer } | null = null;
  private aniso = 0;
  private warned = new Set<string>();
  drawCalls = 0;
  renderHeight = 0;

  constructor(private canvas: OffscreenCanvas | HTMLCanvasElement, private glide: Glide) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.prog = compile(gl, VS, FS);
    for (const n of ["u_screen", "u_pointSize", "u_tex", "u_fogTex", "u_texOn", "u_texScale", "u_cc", "u_ac", "u_tc", "u_inv", "u_const",
      "u_alphaFunc", "u_alphaRef", "u_depthMode", "u_bias", "u_fogMode", "u_fogColor", "u_chroma", "u_chromaKey"]) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    this.lfbProg = compile(gl, LFB_VS, LFB_FS);
    for (const n of ["u_rect", "u_screen", "u_img"]) this.lu[n] = gl.getUniformLocation(this.lfbProg, n);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.staging.byteLength, gl.STREAM_DRAW);
    const stride = VF * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 32);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 56);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);

    this.fogTex = this.makeTex(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(256));
    this.lfbTex = this.makeTex(gl.NEAREST);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext) this.aniso = Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number);
    this.resize(canvas.width, canvas.height);
  }

  private makeTex(filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Sets the canvas size in device pixels; the game renders at the largest 4:3 size that fits. */
  resize(cw: number, ch: number): void {
    this.flush();
    this.canvas.width = Math.max(1, cw);
    this.canvas.height = Math.max(1, ch);
    const aspect = this.width / this.height;
    let h = this.renderHeight || Math.min(ch, Math.floor(cw / aspect));
    h = Math.max(this.height, h);
    this.fbH = h;
    this.fbW = Math.round(h * aspect);
    this.makeTargets();
    this.batchVersion = -1;
  }

  private makeTargets(): void {
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteRenderbuffer(t.color);
      gl.deleteRenderbuffer(t.depth);
    }
    this.targets = [];
    for (let i = 0; i < 2; i++) {
      const fb = gl.createFramebuffer()!;
      const color = gl.createRenderbuffer()!;
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, this.fbW, this.fbH);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.fbW, this.fbH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.clearColor(0, 0, 0, 1);
      gl.clearDepth(1);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this.targets.push({ fb, color, depth });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.back].fb);
  }

  open(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resize(this.canvas.width, this.canvas.height);
  }

  close(): void {}

  private warn(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`glide: ${msg}`);
  }

  private bindBack(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.back].fb);
    gl.viewport(0, 0, this.fbW, this.fbH);
  }

  private scissor(clip: [number, number, number, number]): void {
    const gl = this.gl;
    const sx = this.fbW / this.width, sy = this.fbH / this.height;
    const [x0, y0, x1, y1] = clip;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(x0 * sx), Math.round((this.height - y1) * sy), Math.round((x1 - x0) * sx), Math.round((y1 - y0) * sy));
  }

  clear(color: number, alpha: number, depth: number, st: GlideState): void {
    this.flush();
    const gl = this.gl;
    this.bindBack();
    this.scissor(st.clip);
    gl.colorMask(st.colorMask, st.colorMask, st.colorMask, st.alphaMask);
    gl.depthMask(st.depthMask || st.depthMode !== 0);
    gl.clearColor(((color >>> 16) & 0xff) / 255, ((color >>> 8) & 0xff) / 255, (color & 0xff) / 255, alpha / 255);
    gl.clearDepth((depth & 0xffff) / 65535);
    gl.clear(gl.COLOR_BUFFER_BIT | (st.depthMode !== 0 ? gl.DEPTH_BUFFER_BIT : 0));
    this.batchVersion = -1;
  }

  swap(): void {
    this.flush();
    this.present(this.back);
    this.back ^= 1;
    this.bindBack();
    this.batchVersion = -1;
  }

  private present(index: number): void {
    const gl = this.gl;
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.min(cw / this.fbW, ch / this.fbH);
    const w = Math.round(this.fbW * scale), h = Math.round(this.fbH * scale);
    const x = Math.floor((cw - w) / 2), y = Math.floor((ch - h) / 2);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.targets[index].fb);
    gl.blitFramebuffer(0, 0, this.fbW, this.fbH, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, w === this.fbW ? gl.NEAREST : gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  draw(mode: "tri" | "line" | "point", verts: Float32Array, count: number, st: GlideState): void {
    if (st.version !== this.batchVersion || mode !== this.batchMode || this.count + count > MAX_VERTS) {
      this.flush();
      this.applyState(st);
      this.batchVersion = st.version;
      this.batchMode = mode;
    }
    const dst = this.staging;
    if (mode === "tri" && st.cull !== 0) {
      for (let i = 0; i + 2 < count; i += 3) {
        const a = i * VF, b = a + VF, c = b + VF;
        const area = (verts[a] - verts[b]) * (verts[b + 1] - verts[c + 1]) - (verts[b] - verts[c]) * (verts[a + 1] - verts[b + 1]);
        if (st.cull === 1 ? area < 0 : area > 0) continue;
        dst.set(verts.subarray(a, a + 3 * VF), this.count * VF);
        this.count += 3;
      }
      return;
    }
    dst.set(verts.subarray(0, count * VF), this.count * VF);
    this.count += count;
  }

  private flush(): void {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, this.count * VF);
    gl.drawArrays(this.batchMode === "tri" ? gl.TRIANGLES : this.batchMode === "line" ? gl.LINES : gl.POINTS, 0, this.count);
    this.drawCalls++;
    this.count = 0;
  }

  private applyState(st: GlideState): void {
    const gl = this.gl, u = this.u;
    this.bindBack();
    gl.useProgram(this.prog);
    gl.uniform2f(u.u_screen, this.width, this.height);
    gl.uniform1f(u.u_pointSize, Math.max(1, this.fbH / this.height));
    const cc = st.colorCombine, ac = st.alphaCombine, tc = st.texCombine;
    gl.uniform4i(u.u_cc, cc[0], cc[1], cc[2], cc[3]);
    gl.uniform4i(u.u_ac, ac[0], ac[1], ac[2], ac[3]);
    gl.uniform4i(u.u_tc, tc[0], tc[1], tc[2], tc[3]);
    gl.uniform4i(u.u_inv, cc[4] ? 1 : 0, ac[4] ? 1 : 0, tc[4] ? 1 : 0, tc[5] ? 1 : 0);
    const k = st.constantColor;
    gl.uniform4f(u.u_const, ((k >>> 16) & 0xff) / 255, ((k >>> 8) & 0xff) / 255, (k & 0xff) / 255, (k >>> 24) / 255);
    gl.uniform1i(u.u_alphaFunc, st.alphaTestFunc);
    gl.uniform1f(u.u_alphaRef, st.alphaRef);
    gl.uniform1i(u.u_depthMode, st.depthMode);
    gl.uniform1f(u.u_bias, st.depthBias / 65535);
    gl.uniform1i(u.u_fogMode, st.fogMode);
    const fc = st.fogColor;
    gl.uniform3f(u.u_fogColor, ((fc >>> 16) & 0xff) / 255, ((fc >>> 8) & 0xff) / 255, (fc & 0xff) / 255);
    gl.uniform1i(u.u_chroma, st.chromaMode ? 1 : 0);
    const ck = st.chromaValue;
    gl.uniform3f(u.u_chromaKey, (ck >>> 16) & 0xff, (ck >>> 8) & 0xff, ck & 0xff);

    const [sf, df, asf, adf] = st.blend;
    if (sf === 4 && df === 0 && asf === 4 && adf === 0) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(blendFactor(sf, true), blendFactor(df, false), blendFactor(asf, true), blendFactor(adf, false));
    }
    if (st.depthMode === 0) gl.disable(gl.DEPTH_TEST);
    else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(0x200 + (st.depthFunc & 7));
      gl.depthMask(st.depthMask);
    }
    gl.colorMask(st.colorMask, st.colorMask, st.colorMask, st.alphaMask);
    this.scissor(st.clip);

    if (st.fogMode && st.fogTable !== this.fogSrc) this.updateFog(st.fogTable);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.uniform1i(u.u_fogTex, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_tex, 0);
    const t = st.tex;
    if (!t) {
      gl.uniform1i(u.u_texOn, 0);
      return;
    }
    const ct = this.texture(t);
    gl.uniform1i(u.u_texOn, ct ? 1 : 0);
    if (!ct) return;
    gl.bindTexture(gl.TEXTURE_2D, ct.tex);
    const sMax = t.aspect >= 0 ? 256 : 256 >> -t.aspect;
    const tMax = t.aspect <= 0 ? 256 : 256 >> t.aspect;
    gl.uniform2f(u.u_texScale, sMax, tMax);
    const wrap = (c: number) => (c === 1 ? gl.CLAMP_TO_EDGE : c === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(st.clampS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(st.clampT));
    const lin = st.minFilter === 1;
    const mip = st.mipMode !== 0 && ct.levels > 1;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : lin ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, st.magFilter === 1 ? gl.LINEAR : gl.NEAREST);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, 0x84fe, mip && lin ? this.aniso : 1);
  }

  private updateFog(table: Uint8Array): void {
    this.fogSrc = table;
    const out = new Uint8Array(256);
    for (let k = 0; k < 256; k++) {
      const w = Math.pow(2, (k / 255) * 16);
      let i = 0;
      while (i < 63 && fogIndexToW(i + 1) <= w) i++;
      const w0 = fogIndexToW(i), w1 = fogIndexToW(Math.min(63, i + 1));
      const f = i >= 63 || w1 === w0 ? 0 : Math.min(1, Math.max(0, (w - w0) / (w1 - w0)));
      out[k] = Math.round(table[i] + (table[Math.min(63, i + 1)] - table[i]) * f);
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, out);
    gl.activeTexture(gl.TEXTURE0);
  }

  private texture(t: TexDesc): CachedTex | null {
    const paletted = t.format === 0x5 || t.format === 0x6 || t.format === 0xe;
    const key = `${t.addr}:${t.format}:${t.largeLod}:${t.smallLod}:${t.aspect}${paletted ? ":" + this.palHash : ""}`;
    const hit = this.texCache.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const bpp = texelBytes(t.format);
    const tmu = this.glide.tmu;
    let off = t.addr;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let level = 0;
    for (let lod = t.largeLod; lod >= t.smallLod; lod--, level++) {
      const [w, h] = lodDims(lod, t.aspect);
      const n = w * h;
      if (off + n * bpp > tmu.length) break;
      const rgba = this.decode(t.format, tmu, off, n);
      gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      off += n * bpp;
    }
    if (!level) {
      gl.deleteTexture(tex);
      return null;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
    const ct = { tex, start: t.addr, end: off, levels: level };
    this.texCache.set(key, ct);
    return ct;
  }

  private decode(fmt: number, src: Uint8Array, off: number, n: number): Uint8Array {
    const out = new Uint8Array(n * 4);
    const pal = this.palette;
    const u16 = (i: number) => src[off + i * 2] | (src[off + i * 2 + 1] << 8);
    for (let i = 0; i < n; i++) {
      let r = 255, g = 255, b = 255, a = 255;
      switch (fmt) {
        case 0x0: {
          const v = src[off + i];
          r = ((v >> 5) & 7) * 255 / 7; g = ((v >> 2) & 7) * 255 / 7; b = (v & 3) * 85;
          break;
        }
        case 0x2: r = g = b = a = src[off + i]; break;
        case 0x3: r = g = b = src[off + i]; break;
        case 0x4: { const v = src[off + i]; a = expand4(v >> 4); r = g = b = expand4(v & 15); break; }
        case 0x5: { const p = pal[src[off + i]]; r = (p >> 16) & 0xff; g = (p >> 8) & 0xff; b = p & 0xff; break; }
        case 0x6: {
          const p = pal[src[off + i]];
          a = expand6((p >> 18) & 0x3f); r = expand6((p >> 12) & 0x3f); g = expand6((p >> 6) & 0x3f); b = expand6(p & 0x3f);
          break;
        }
        case 0x8: {
          const v = u16(i);
          a = v >> 8; r = ((v >> 5) & 7) * 255 / 7; g = ((v >> 2) & 7) * 255 / 7; b = (v & 3) * 85;
          break;
        }
        case 0xa: { const v = u16(i); r = expand5(v >> 11); g = expand6((v >> 5) & 0x3f); b = expand5(v & 0x1f); break; }
        case 0xb: { const v = u16(i); a = v & 0x8000 ? 255 : 0; r = expand5((v >> 10) & 0x1f); g = expand5((v >> 5) & 0x1f); b = expand5(v & 0x1f); break; }
        case 0xc: { const v = u16(i); a = expand4(v >> 12); r = expand4((v >> 8) & 15); g = expand4((v >> 4) & 15); b = expand4(v & 15); break; }
        case 0xd: { const v = u16(i); a = v >> 8; r = g = b = v & 0xff; break; }
        case 0xe: { const v = u16(i); a = v >> 8; const p = pal[v & 0xff]; r = (p >> 16) & 0xff; g = (p >> 8) & 0xff; b = p & 0xff; break; }
        case 0x12: {
          const o = off + i * 4;
          b = src[o]; g = src[o + 1]; r = src[o + 2]; a = src[o + 3];
          break;
        }
        default:
          this.warn(`texture format ${fmt.toString(16)} not supported`);
          r = g = b = fmt === 0x1 || fmt === 0x9 ? src[off + i * (fmt === 0x9 ? 2 : 1)] : 255;
      }
      const o = i * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    return out;
  }

  texWritten(addr: number, len: number): void {
    this.flush();
    const end = addr + len;
    for (const [k, t] of this.texCache) {
      if (t.start < end && addr < t.end) {
        this.gl.deleteTexture(t.tex);
        this.texCache.delete(k);
      }
    }
    this.batchVersion = -1;
  }

  paletteChanged(pal: Uint32Array): void {
    this.flush();
    this.palette.set(pal);
    let h = 0x811c9dc5;
    for (let i = 0; i < 256; i++) h = Math.imul(h ^ pal[i], 0x01000193);
    this.palHash = h >>> 0;
    this.batchVersion = -1;
  }

  lfbWrite(buffer: number, x: number, y: number, w: number, h: number, px: Uint16Array | Uint32Array, fmt: number): void {
    this.flush();
    const gl = this.gl;
    const n = w * h;
    const rgba = new Uint8Array(n * 4);
    const f = fmt & 0xf;
    for (let i = 0; i < n; i++) {
      const v = px[i];
      const o = i * 4;
      if (px instanceof Uint32Array) {
        if (v === LFB_UNTOUCHED32) continue;
        rgba[o] = (v >>> 16) & 0xff; rgba[o + 1] = (v >>> 8) & 0xff; rgba[o + 2] = v & 0xff;
      } else {
        if (v === LFB_UNTOUCHED16) continue;
        if (f === 0x1 || f === 0x2) {
          rgba[o] = expand5((v >> 10) & 0x1f); rgba[o + 1] = expand5((v >> 5) & 0x1f); rgba[o + 2] = expand5(v & 0x1f);
        } else {
          rgba[o] = expand5(v >> 11); rgba[o + 1] = expand6((v >> 5) & 0x3f); rgba[o + 2] = expand5(v & 0x1f);
        }
      }
      rgba[o + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lfbTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const target = buffer === 0 ? this.back ^ 1 : this.back;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[target].fb);
    gl.viewport(0, 0, this.fbW, this.fbH);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.lfbProg);
    gl.uniform4f(this.lu.u_rect, x, y, w, h);
    gl.uniform2f(this.lu.u_screen, this.width, this.height);
    gl.uniform1i(this.lu.u_img, 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
    if (buffer === 0) this.present(target);
    this.bindBack();
    this.batchVersion = -1;
  }

  lfbRead(buffer: number, w: number, h: number): Uint16Array {
    this.flush();
    const gl = this.gl;
    if (!this.readTarget) {
      const fb = gl.createFramebuffer()!;
      const rb = gl.createRenderbuffer()!;
      this.readTarget = { fb, rb };
    }
    const { fb, rb } = this.readTarget;
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.targets[buffer === 0 ? this.back ^ 1 : this.back].fb);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, this.fbW, this.fbH, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const out = new Uint16Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const o = ((h - 1 - j) * w + i) * 4;
        out[j * w + i] = ((rgba[o] >> 3) << 11) | ((rgba[o + 1] >> 2) << 5) | (rgba[o + 2] >> 3);
      }
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.bindBack();
    this.batchVersion = -1;
    return out;
  }
}
