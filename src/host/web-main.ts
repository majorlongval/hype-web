import type { DiscSpec, FromWorker, ToWorker, ToWorklet } from "./protocol";
import { KEYMAP } from "../win32/keys";
import { buttonChanges, DEFAULT_CONTROLS, type ControlOptions, type Preset } from "./controls";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setup = $<HTMLDivElement>("setup");
const picker = $<HTMLInputElement>("picker");
const isoPicker = $<HTMLInputElement>("iso");
const playBtn = $<HTMLButtonElement>("play");
const langSel = $<HTMLSelectElement>("lang");
const statusEl = $<HTMLDivElement>("status");
const statsEl = $<HTMLDivElement>("stats");
const loadingEl = $<HTMLDivElement>("loading");
const loadingStatus = $<HTMLSpanElement>("loading-status");
const hud = $<HTMLDivElement>("hud");
const volumeEl = $<HTMLInputElement>("volume");
const fullscreenBtn = $<HTMLButtonElement>("fullscreen");
const logEl = $<HTMLPreElement>("log");
const stage = $<HTMLDivElement>("stage");
const canvas = $<HTMLCanvasElement>("screen");
const preset = $<HTMLSelectElement>("preset");
const presetDialog = $<HTMLSelectElement>("preset-dialog");
const controlsDialog = $<HTMLDialogElement>("controls-dialog");
const typingBtn = $<HTMLButtonElement>("typing");
const inputHint = $<HTMLDivElement>("input-hint");
const mouseEnabled = $<HTMLInputElement>("mouse-enabled");
const invertY = $<HTMLInputElement>("invert-y");
const sensitivity = $<HTMLInputElement>("sensitivity");
const tapAssist = $<HTMLInputElement>("tap-assist");
const skipVideoBtn = $<HTMLButtonElement>("skip-video");
const skipVideosSetup = $<HTMLInputElement>("skip-videos-setup");
const skipVideosEl = $<HTMLInputElement>("skip-videos");
const widescreenEl = $<HTMLInputElement>("widescreen");
const fastForwardBtn = $<HTMLButtonElement>("fast-forward");
let skipVideos = false;
try { skipVideos = localStorage.getItem("hype-skip-videos") === "true"; } catch {}
try { widescreenEl.checked = localStorage.getItem("hype-widescreen") !== "false"; } catch {}
widescreenEl.addEventListener("change", () => { try { localStorage.setItem("hype-widescreen", String(widescreenEl.checked)); } catch {} });
let fastForward = false;
let audioGain: GainNode | null = null;
let resetAudio = () => {};
let controlOptions: ControlOptions = { ...DEFAULT_CONTROLS };
try {
  const saved = JSON.parse(localStorage.getItem("hype-controls") ?? "null");
  if (saved) controlOptions = { preset: saved.preset === "original" ? "original" : "modern", mouse: saved.mouse !== false,
    invertY: saved.invertY === true, sensitivity: Math.max(0.25, Math.min(6, Number(saved.sensitivity) || 2)), typing: false, tapAssist: saved.tapAssist !== false };
} catch {}
let aiming = false;
let mouseButtons = 0;

const params = new URLSearchParams(location.search);
let disc: DiscSpec | null = params.get("disc") === "http" ? { kind: "http", label: params.get("label") ?? "", base: "/disc/" } : null;
let worker: Worker | null = null;

const lang = navigator.language.slice(0, 2);
langSel.value = { fr: "French", de: "German", es: "Spanish", it: "Italian" }[lang] ?? "English";

function status(msg: string): void {
  statusEl.textContent = msg;
  loadingStatus.textContent = msg;
}

function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem("hype-volume"));
    return localStorage.getItem("hype-volume") !== null && v >= 0 && v <= 1 ? v : 0.8;
  } catch {
    return 0.8;
  }
}

statsEl.hidden = !params.has("stats");

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
  const root = files.find(([p]) => ["INSTDATA\\UBI.INS", "INSTDATA\\UBIINS.DAT"].includes(p.toUpperCase()));
  if (!root) {
    status("That folder isn't a Hype disc: its InstData installer files were not found. Pick the root folder of the CD.");
    return;
  }
  disc = { kind: "files", label: "", files };
  status(`${files.length} files ready.`);
  playBtn.disabled = false;
});

isoPicker.addEventListener("change", () => {
  const file = isoPicker.files?.[0];
  if (!file) return;
  disc = { kind: "iso", file };
  status(`${file.name} ready.`);
  playBtn.disabled = false;
});

if (disc) {
  playBtn.disabled = false;
  status("Development disc from the local server.");
}

function wideWidth([w, h]: [number, number]): number {
  const width = Math.min(1280, Math.round((480 * w) / h / 2) * 2);
  return width > 640 ? width : 0;
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
  const gain = audio.createGain();
  audioGain = gain;
  gain.gain.value = savedVolume();
  volumeEl.value = String(gain.gain.value);
  volumeEl.addEventListener("input", () => {
    gain.gain.value = fastForward ? 0 : Number(volumeEl.value);
    try {
      localStorage.setItem("hype-volume", volumeEl.value);
    } catch {}
  });
  volumeEl.addEventListener("change", () => volumeEl.blur());
  node.connect(gain).connect(audio.destination);
  const toAudio = (msg: ToWorklet, transfer: Transferable[] = []) => node.port.postMessage(msg, transfer);
  resetAudio = () => toAudio({ t: "reset-all" });

  worker = new Worker("worker.js");
  updateControls();
  updatePlayback();
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    switch (msg.t) {
      case "log": addLog(msg.msg); break;
      case "status": status(msg.msg); break;
      case "playback-state": skipVideoBtn.disabled = !msg.video; break;
      case "stats":
        if (msg.fps > 0) loadingEl.hidden = true;
        statsEl.textContent = `${msg.fps.toFixed(1)} fps · ${msg.mips.toFixed(0)} MIPS · ${msg.draws.toFixed(0)} draws/frame`; break;
      case "audio-open": toAudio({ t: "open", id: msg.id, rate: msg.rate, channels: msg.channels }); break;
      case "audio-data": if (!fastForward) toAudio({ t: "data", id: msg.id, data: msg.data }, [msg.data.buffer]); break;
      case "audio-close": toAudio({ t: "close", id: msg.id }); break;
      case "audio-reset": toAudio({ t: "reset", id: msg.id }); break;
      case "exit": status(`The game exited (code ${msg.code}).`); break;
      case "error": status(`Stopped: ${msg.msg.split("\n")[0]}`); addLog(msg.msg); break;
    }
  };
  const [w, h] = deviceSize();
  const off = canvas.transferControlToOffscreen();
  send({ t: "start", disc, canvas: off, width: w, height: h, language: langSel.value, msaa: Number(params.get("msaa") ?? 4), wide: widescreenEl.checked ? wideWidth([w, h]) : 0 }, [off]);
  widescreenEl.disabled = true;
  new ResizeObserver(() => {
    const [cw, ch] = deviceSize();
    send({ t: "resize", width: cw, height: ch });
  }).observe(stage);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseInput();
    send({ t: "pause", paused: document.hidden || controlsDialog.open });
    if (document.hidden) audio.suspend();
    else audio.resume();
  });
  pollPad();
}

playBtn.addEventListener("click", () => {
  play().catch((e: Error) => status(`Could not start: ${e.message}`));
});

function onKey(e: KeyboardEvent, down: boolean): void {
  if (controlsDialog.open || (e.target instanceof HTMLElement && e.target.closest("input, select, button, textarea, [contenteditable]"))) {
    if (!down && worker && KEYMAP[e.code]) send({ t: "key", code: e.code, down: false });
    return;
  }
  if (worker && e.code === "Backquote" && controlOptions.preset === "modern") {
    e.preventDefault();
    if (down && !e.repeat) toggleTyping();
    return;
  }
  if (!worker || !KEYMAP[e.code] || e.code === "F11" || e.code === "F12") return;
  e.preventDefault();
  if (down && e.repeat) return;
  send({ t: "key", code: e.code, down });
}
window.addEventListener("keydown", (e) => onKey(e, true));
window.addEventListener("keyup", (e) => onKey(e, false));
window.addEventListener("blur", releaseInput);

function releaseInput(): void {
  aiming = false;
  mouseButtons = 0;
  send({ t: "input-reset" });
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

function updateControls(): void {
  releaseInput();
  preset.value = presetDialog.value = controlOptions.preset;
  mouseEnabled.checked = controlOptions.mouse;
  invertY.checked = controlOptions.invertY;
  sensitivity.value = String(controlOptions.sensitivity);
  tapAssist.checked = controlOptions.tapAssist;
  $("modern-guide").hidden = controlOptions.preset !== "modern";
  $("original-guide").hidden = controlOptions.preset !== "original";
  typingBtn.hidden = controlOptions.preset !== "modern";
  typingBtn.textContent = `Typing: ${controlOptions.typing ? "on" : "off"}`;
  typingBtn.setAttribute("aria-pressed", String(controlOptions.typing));
  inputHint.hidden = controlOptions.preset !== "modern";
  inputHint.textContent = controlOptions.typing ? "Typing mode — press ` or Typing to resume modern controls" : "WASD move / turn · Space jump · E or click = game's SPACE (action, dialogue) · Hold right mouse to look · Controls in top bar";
  send({ t: "controls", options: controlOptions });
  try { localStorage.setItem("hype-controls", JSON.stringify({ ...controlOptions, typing: false })); } catch {}
}
function toggleTyping(): void { controlOptions.typing = !controlOptions.typing; updateControls(); typingBtn.blur(); }
typingBtn.addEventListener("click", toggleTyping);
for (const sel of [preset, presetDialog]) sel.addEventListener("change", () => {
  controlOptions.preset = sel.value as Preset; controlOptions.typing = false; updateControls(); sel.blur();
});
mouseEnabled.addEventListener("change", () => { controlOptions.mouse = mouseEnabled.checked; updateControls(); });
invertY.addEventListener("change", () => { controlOptions.invertY = invertY.checked; updateControls(); });
sensitivity.addEventListener("input", () => { controlOptions.sensitivity = Number(sensitivity.value); updateControls(); });
tapAssist.addEventListener("change", () => { controlOptions.tapAssist = tapAssist.checked; updateControls(); });
function updatePlayback(): void {
  skipVideosEl.checked = skipVideosSetup.checked = skipVideos;
  fastForwardBtn.textContent = fastForward ? "Stop fast-forward" : "Fast-forward";
  fastForwardBtn.setAttribute("aria-pressed", String(fastForward));
  if (audioGain) audioGain.gain.value = fastForward ? 0 : Number(volumeEl.value);
  send({ t: "playback", skipVideos, fastForward });
  try { localStorage.setItem("hype-skip-videos", String(skipVideos)); } catch {}
}
for (const el of [skipVideosEl, skipVideosSetup]) el.addEventListener("change", () => {
  skipVideos = el.checked; updatePlayback(); el.blur();
});
skipVideoBtn.addEventListener("click", () => { send({ t: "skip-video" }); skipVideoBtn.blur(); });
fastForwardBtn.addEventListener("click", () => {
  releaseInput(); fastForward = !fastForward; resetAudio(); updatePlayback(); fastForwardBtn.blur();
});
updatePlayback();
function showControls(): void {
  releaseInput(); controlsDialog.showModal(); send({ t: "pause", paused: true });
}
for (const id of ["controls-setup", "controls-open"]) $(id).addEventListener("click", showControls);
$("controls-close").addEventListener("click", () => controlsDialog.close());
controlsDialog.addEventListener("close", () => {
  send({ t: "pause", paused: document.hidden });
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});
const useMouse = () => !!worker && !controlsDialog.open && controlOptions.preset === "modern" && controlOptions.mouse && !controlOptions.typing;
canvas.addEventListener("contextmenu", (e) => { if (useMouse()) e.preventDefault(); });
function syncButtons(e: PointerEvent): void {
  for (const [button, down] of buttonChanges(mouseButtons, e.buttons)) {
    send({ t: "mouse-button", button, down });
    if (button !== 2) continue;
    aiming = down;
    if (!down) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      continue;
    }
    // Right-drag remains available in browsers that do not grant pointer lock.
    try {
      const request = canvas.requestPointerLock?.() as Promise<void> | undefined;
      request?.then(() => { if (!aiming && document.pointerLockElement === canvas) document.exitPointerLock(); }).catch(() => {});
    } catch {}
  }
  mouseButtons = e.buttons;
}
canvas.addEventListener("pointerdown", (e) => {
  if (!useMouse() || e.pointerType !== "mouse") return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  syncButtons(e);
});
window.addEventListener("pointermove", (e) => { if (mouseButtons && useMouse() && e.pointerType === "mouse") syncButtons(e); });
window.addEventListener("pointerup", (e) => { if (mouseButtons && useMouse() && e.pointerType === "mouse") syncButtons(e); });
canvas.addEventListener("pointercancel", releaseInput);
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== canvas && aiming) {
    aiming = false; mouseButtons = 0; send({ t: "input-reset", mouseOnly: true });
  }
});
document.addEventListener("mousemove", (e) => {
  if (useMouse() && aiming) send({ t: "mouse-move", dx: e.movementX, dy: e.movementY });
});
canvas.addEventListener("wheel", (e) => {
  if (!useMouse()) return;
  e.preventDefault(); send({ t: "mouse-wheel" });
}, { passive: false });
updateControls();

function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
}
canvas.addEventListener("dblclick", () => { if (!useMouse()) toggleFullscreen(); });
fullscreenBtn.addEventListener("click", () => {
  toggleFullscreen();
  fullscreenBtn.blur();
});

let hudTimer = 0;
stage.addEventListener("mousemove", () => {
  hud.classList.add("show");
  clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => hud.classList.remove("show"), 2500);
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
