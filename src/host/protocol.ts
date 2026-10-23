import type { ControlOptions } from "./controls";

export type DiscSpec =
  | { kind: "files"; label: string; files: [string, File][] }
  | { kind: "http"; label: string; base: string }
  | { kind: "iso"; file: File };

export type ToWorker =
  | { t: "start"; disc: DiscSpec; canvas: OffscreenCanvas; width: number; height: number; language: string; msaa: number; wide: number }
  | { t: "key"; code: string; down: boolean }
  | { t: "controls"; options: ControlOptions }
  | { t: "input-reset"; mouseOnly?: boolean }
  | { t: "mouse-button"; button: number; down: boolean }
  | { t: "mouse-move"; dx: number; dy: number }
  | { t: "mouse-wheel" }
  | { t: "playback"; skipVideos: boolean; fastForward: boolean }
  | { t: "skip-video" }
  | { t: "resize"; width: number; height: number }
  | { t: "pad"; connected: boolean; buttons: number; axes: number[] }
  | { t: "pause"; paused: boolean };

export type FromWorker =
  | { t: "playback-state"; video: boolean }
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
  | { t: "reset-all" }
  | { t: "open"; id: number; rate: number; channels: number }
  | { t: "data"; id: number; data: Float32Array }
  | { t: "close"; id: number }
  | { t: "reset"; id: number };
