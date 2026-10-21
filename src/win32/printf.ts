import type { Machine } from "./machine";

/** Minimal C printf formatter reading 32-bit args from guest memory at `argp`. */
export function formatPrintf(m: Machine, fmt: string, argp: number): string {
  const dv = m.mem.dv;
  let out = "";
  let ap = argp;
  const next = () => {
    const v = dv.getUint32(ap, true);
    ap += 4;
    return v;
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    let flags = "";
    while ("-+ #0".includes(fmt[i + 1] ?? "x")) flags += fmt[++i];
    let width = "";
    if (fmt[i + 1] === "*") {
      i++;
      width = String(next() | 0);
    } else while (/\d/.test(fmt[i + 1] ?? "")) width += fmt[++i];
    let prec = "";
    if (fmt[i + 1] === ".") {
      i++;
      if (fmt[i + 1] === "*") {
        i++;
        prec = String(next() | 0);
      } else while (/\d/.test(fmt[i + 1] ?? "")) prec += fmt[++i];
    }
    while ("lhLwI".includes(fmt[i + 1] ?? "x")) i++;
    const conv = fmt[++i];
    let s: string;
    switch (conv) {
      case "d": case "i": s = String(next() | 0); break;
      case "u": s = String(next() >>> 0); break;
      case "x": s = (next() >>> 0).toString(16); if (flags.includes("#")) s = "0x" + s; break;
      case "X": s = (next() >>> 0).toString(16).toUpperCase(); if (flags.includes("#")) s = "0X" + s; break;
      case "o": s = (next() >>> 0).toString(8); break;
      case "c": s = String.fromCharCode(next() & 0xff); break;
      case "s": case "S": {
        const p = next();
        s = p ? m.mem.readCString(p) : "(null)";
        if (prec) s = s.slice(0, Number(prec));
        break;
      }
      case "p": s = (next() >>> 0).toString(16).toUpperCase().padStart(8, "0"); break;
      case "f": case "g": case "e": {
        const lo = next(), hi = next();
        const b = new DataView(new ArrayBuffer(8));
        b.setUint32(0, lo, true);
        b.setUint32(4, hi, true);
        const v = b.getFloat64(0, true);
        s = conv === "f" ? v.toFixed(prec ? Number(prec) : 6) : conv === "e" ? v.toExponential(prec ? Number(prec) : 6) : String(v);
        break;
      }
      case "%": s = "%"; break;
      default: s = conv ?? ""; break;
    }
    if ("diuxXo".includes(conv) && prec) s = s.padStart(Number(prec), "0");
    if (width && s.length < Number(width)) {
      s = flags.includes("-") ? s.padEnd(Number(width)) : flags.includes("0") && "diuxXo".includes(conv) ? s.padStart(Number(width), "0") : s.padStart(Number(width));
    }
    out += s;
  }
  return out;
}
