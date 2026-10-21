import type { DiscSpec, FromWorker, ToWorker, ToWorklet } from "./protocol";
import { KEYMAP } from "../win32/keys";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setup = $<HTMLDivElement>("setup");
const picker = $<HTMLInputElement>("picker");
const playBtn = $<HTMLButtonElement>("play");
const langSel = $<HTMLSelectElement>("lang");
const statusEl = $<HTMLDivElement>("status");
const statsEl = $<HTMLDivElement>("stats");
const logEl = $<HTMLPreElement>("log");
const stage = $<HTMLDivElement>("stage");
const canvas = $<HTMLCanvasElement>("screen");

const params = new URLSearchParams(location.search);
let disc: DiscSpec | null = params.get("disc") === "http" ? { kind: "http", label: params.get("label") ?? "", base: "/disc/" } : null;
let worker: Worker | null = null;

const lang = navigator.language.slice(0, 2);
langSel.value = { fr: "French", de: "German", es: "Spanish", it: "Italian" }[lang] ?? "English";

function status(msg: string): void {
  statusEl.textContent = msg;
}

function addLog(msg: string): void {
  logEl.textContent += `${msg}\n`;
  if (logEl.textContent!.length > 20000) logEl.textContent = logEl.textContent!.slice(-15000);
  logEl.scrollTop = logEl.scrollHeight;
}

picker.addEventListener("change", () => {
  const list = [...(picker.files ?? [])];
  if (!list.length) return;
  const strip = (p: string) => p.split("/").slice(1).join("\\");
  const files: [string, File][] = list.map((f) => [strip(f.webkitRelativePath || f.name), f]);
  const root = files.find(([p]) => p.toUpperCase() === "INSTDATA\\UBI.INS");
  if (!root) {
    status("That folder isn't a Hype disc: InstData\\ubi.ins was not found. Pick the root folder of the CD.");
    return;
  }
  disc = { kind: "files", label: "", files };
  status(`${files.length} files ready.`);
  playBtn.disabled = false;
});

if (disc) {
  playBtn.disabled = false;
  status("Development disc from the local server.");
}

function deviceSize(): [number, number] {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [Math.round(r.width * dpr), Math.round(r.height * dpr)];
}

const send = (msg: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(msg, transfer);

async function play(): Promise<void> {
  if (!disc) return;
  playBtn.disabled = true;
  setup.hidden = true;
  stage.hidden = false;
  const audio = new AudioContext({ latencyHint: "interactive" });
  await audio.audioWorklet.addModule("audio-worklet.js");
  const node = new AudioWorkletNode(audio, "hype-audio", { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(audio.destination);
  const toAudio = (msg: ToWorklet, transfer: Transferable[] = []) => node.port.postMessage(msg, transfer);

  worker = new Worker("worker.js");
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    switch (msg.t) {
      case "log": addLog(msg.msg); break;
      case "status": status(msg.msg); break;
      case "stats": statsEl.textContent = `${msg.fps.toFixed(1)} fps · ${msg.mips.toFixed(0)} MIPS · ${msg.draws.toFixed(0)} draws/frame`; break;
      case "audio-open": toAudio({ t: "open", id: msg.id, rate: msg.rate, channels: msg.channels }); break;
      case "audio-data": toAudio({ t: "data", id: msg.id, data: msg.data }, [msg.data.buffer]); break;
      case "audio-close": toAudio({ t: "close", id: msg.id }); break;
      case "audio-reset": toAudio({ t: "reset", id: msg.id }); break;
      case "exit": status(`The game exited (code ${msg.code}).`); break;
      case "error": status("The emulator stopped on an error (details in the log)."); addLog(msg.msg); break;
    }
  };
  const [w, h] = deviceSize();
  const off = canvas.transferControlToOffscreen();
  send({ t: "start", disc, canvas: off, width: w, height: h, language: langSel.value }, [off]);
  new ResizeObserver(() => {
    const [cw, ch] = deviceSize();
    send({ t: "resize", width: cw, height: ch });
  }).observe(stage);
  document.addEventListener("visibilitychange", () => {
    send({ t: "pause", paused: document.hidden });
    if (document.hidden) audio.suspend();
    else audio.resume();
  });
  pollPad();
}

playBtn.addEventListener("click", () => {
  play().catch((e: Error) => status(`Could not start: ${e.message}`));
});

function onKey(e: KeyboardEvent, down: boolean): void {
  if (!worker || !KEYMAP[e.code] || e.code === "F11" || e.code === "F12") return;
  e.preventDefault();
  if (down && e.repeat) return;
  send({ t: "key", code: e.code, down });
}
window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));
window.addEventListener("blur", () => {
  for (const code of Object.keys(KEYMAP)) send({ t: "key", code, down: false });
});

canvas.addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
});

let lastPad = "";
function pollPad(): void {
  const p = navigator.getGamepads?.()[0];
  let buttons = 0;
  const axes = p ? p.axes.slice(0, 4).map((a) => (Math.abs(a) < 0.15 ? 0 : a)) : [];
  if (p) p.buttons.forEach((b, i) => { if (b.pressed && i < 16) buttons |= 1 << i; });
  const key = `${!!p}:${buttons}:${axes.map((a) => a.toFixed(2)).join(",")}`;
  if (key !== lastPad) {
    lastPad = key;
    send({ t: "pad", connected: !!p, buttons, axes });
  }
  requestAnimationFrame(pollPad);
}
