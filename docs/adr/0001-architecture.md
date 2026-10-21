# ADR 0001: Run the original game binaries on an x86 emulator with rewritten Windows libraries

Date: 2026-10-21. Status: accepted.

## Context

The goal is to play Hype: The Time Quest (Ubi Soft, 1999) from start to end in a web browser, at 720p or 1080p.
The game is still under copyright and isn't sold anywhere, so the app can't ship game files. Players load files from their own disc.

The game is a Win32 program that uses MFC42, MSVCRT, Glide 3 (3dfx), DirectInput, winmm (waveOut, MCI), and AVIFile for videos.

## Decision

- Emulate a 32-bit x86 CPU in the browser. A TypeScript interpreter is the reference. A JIT that compiles hot code to WebAssembly provides the speed.
- Run the game's own x86 code: the exe, MFC42.dll, MSVCRT.dll, and the sound DLLs from the disc.
- Rewrite the Windows system libraries in TypeScript (high-level emulation): kernel32, user32, gdi32, advapi32, winmm, dinput, avifil32, msacm32, msvfw32.
- Rewrite glide3x.dll on top of WebGL2. Glide receives screen-space vertices, so the renderer scales them to any output resolution. That is how the game gets upscaled.
- Use one guest thread at a time, with cooperative scheduling. Blocking Windows calls are written as generator functions, so they can wait or call back into guest code without nesting run loops.
- The browser build runs the emulator in a Web Worker. It draws with WebGL2 on an OffscreenCanvas, reads files through OPFS (the browser's private file storage, with synchronous reads in workers), and plays audio through an AudioWorklet.
- A Node build runs the same core headless, for tests and debugging.

## Alternatives rejected

- Boxedwine (Wine compiled to WebAssembly): its web build has no JIT yet, and the game would run Wine's own code under emulation on every system call. Too slow for a 3D game.
- Windows 98 in v86: needs a Windows license, has no 3D card emulation, and is slow.
- Reimplementing the OpenSpace engine on the original data: months of work, and the game logic (AI scripts, physics) would never match exactly.
- Streaming a native Wine session to a browser: the game wouldn't run in the browser itself.

## Consequences

- The app contains no Ubisoft code, so it can be hosted publicly. Players provide their own disc.
- Every Windows function the game calls must be written by hand. Calls to missing functions are logged loudly, so gaps show up early.
- Video playback needs a decoder for whatever codec the disc uses (probably Indeo 5).
