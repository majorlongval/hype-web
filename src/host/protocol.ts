export type DiscSpec =
  | { kind: "files"; label: string; files: [string, File][] }
  | { kind: "http"; label: string; base: string };

export type ToWorker =
  | { t: "start"; disc: DiscSpec; canvas: OffscreenCanvas; width: number; height: number; language: string }
  | { t: "key"; code: string; down: boolean }
  | { t: "resize"; width: number; height: number }
  | { t: "pad"; connected: boolean; buttons: number; axes: number[] }
  | { t: "pause"; paused: boolean };

export type FromWorker =
  | { t: "log"; msg: string }
  | { t: "status"; msg: string }
  | { t: "stats"; fps: number; mips: number; draws: number }
  | { t: "audio-open"; id: number; rate: number; channels: number }
  | { t: "audio-data"; id: number; data: Float32Array }
  | { t: "audio-close"; id: number }
  | { t: "audio-reset"; id: number }
  | { t: "exit"; code: number }
  | { t: "error"; msg: string };

export type ToWorklet =
  | { t: "open"; id: number; rate: number; channels: number }
  | { t: "data"; id: number; data: Float32Array }
  | { t: "close"; id: number }
  | { t: "reset"; id: number };
