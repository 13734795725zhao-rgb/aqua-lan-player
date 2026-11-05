<div align="center">
  <img src="docs/assets/banner.svg" alt="AQUA — a host-embedded local video player for Windows" width="880">
</div>

<br>

<div align="center">

**A local video library player that feels native, because the UI is not drawn by mpv.**

Electron owns the windows and the interface. `libmpv` owns exactly one thing: painting frames into a native child window we hand it.

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6?logo=windows&logoColor=white)](#requirements)
[![Electron](https://img.shields.io/badge/Electron-shell-47848F?logo=electron&logoColor=white)](#architecture)
[![libmpv](https://img.shields.io/badge/core-libmpv-6911AB)](#requirements)
[![UI](https://img.shields.io/badge/UI-acrylic%20glass-38BDF8)](#why-the-sidebar-is-a-separate-window)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Why](#why-host-embedding) · [Architecture](#architecture) · [Features](#features) · [Getting started](#getting-started) · [The hard parts](#the-hard-parts)

</div>

---

## Why host embedding

mpv is an outstanding playback engine with a mediocre UI toolkit. Skinning it means writing Lua, fighting `libass`, and rebuilding the same list widget everyone else already built badly.

This project takes the other road — the one IINA and LosslessCut take: **let mpv decode and paint, let the host draw everything else.** Electron renders the title bar, the sidebar, the controls and the menus as real web UI, then passes a native window handle to `mpv` via `--wid`. The result is system acrylic blur, native file dialogs, virtualised lists and spring scrolling — none of which you can get from inside mpv's OSD.

This repository contains **the host shell only**. mpv source and mpv binaries are not bundled; see [Requirements](#requirements).

---

## Architecture

| Layer | File | Responsibility |
|---|---|---|
| Native | `app/src/main/win32.js` | Create the video carrier window (`--wid` target); enable system acrylic on overlay windows |
| Binding | `app/src/main/mpv.js` | `koffi` FFI straight into `libmpv-2.dll`: `mpv_create`, `set_option_string("wid", …)`, `command`, `wait_event` — plus a headless second instance for duration probing |
| State | `app/src/main/main.js` | Single source of truth driving every window; mpv viewport resynced once, after the sidebar animation ends |
| UI | `app/src/renderer/` | Shell title bar with traffic lights, frosted sidebar, bottom control capsule, input glass layer, menus, preview |

```
┌─ shell window (Electron, acrylic) ───────────────────┐
│  ● ● ●   filename.mp4        外观  侧栏  画中画  全屏 │
│  ┌────────────┬──────────────────────────────────┐   │
│  │  sidebar   │        mpv video surface         │   │
│  │  (own HWND)│        (own HWND, owned)         │   │
│  └────────────┴──────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐    │
│  │  底栏胶囊：音量 · 时间码 · ⏪ ⏸ ⏩ · 倍速      │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
   Z-order: input glass  →  mpv surface  →  shell
```

---

## Features

### Playback

| | |
|---|---|
| **shuttle acceleration** | Hold skip-backward / skip-forward: 0.35 s → 2×, 1 s → 5×, 1.8 s → 12×; releasing restores the previous speed |
| **frame-accurate scrubbing** | Dragging the progress bar seeks with `absolute+exact` and pauses audio underneath, resuming on release |
| **hover thumbnails** | A third libmpv instance renders the preview frame at the cursor position |
| **speed without chipmunk voice** | `audio-pitch-correction=yes` (scaletempo2) keeps voices natural at 1.5× and 2× |
| **picture-in-picture** | `Ctrl+P` shrinks the main window to a borderless always-on-top overlay locked to the video aspect ratio |
| **immersive fullscreen** | `F`, double-click, or the title-bar button; after 2.5 s of stillness the cursor hides and returns on movement |
| **auto-advance** | `Ctrl+←` / `Ctrl+→` for previous/next; playback end advances automatically |

### Library sidebar

| | |
|---|---|
| **Multiple ways in** | Split button (picker + recent 5 / pinned / clear history), breadcrumbs, drag a folder straight from Explorer |
| **Virtualised list** | Only the visible dozen rows exist; tens of thousands of files scroll without a hitch |
| **Spring scrolling** | Stiffness/damping integrator — real inertia and edge bounce, not CSS easing |
| **Playback context** | Current item shows an animated equaliser bar; 2 px progress line per card; `✓` when finished; `CC` when a matching `.srt/.ass/.vtt` exists; `♪` for `.m4a/.aac` |
| **Resume** | Watch position written every 5 s, restored on reopen |
| **Broken files** | Rows grey out with a strikethrough; the file is probed before playback so the core never crashes |
| **System menu** | Reveal in Explorer, copy path, copy name, attach external subtitle, hide, rename, move to recycle bin |
| **Keyboard-only use** | `↑↓` focus, `Enter` play, `Space` pause, type-ahead (`03` jumps to that entry), `Esc` clears the search then closes |
| **Sorting and views** | Natural filename / modified time / duration / progress; hide extensions; compact 68→48 px rows |

### Window behaviour

| | |
|---|---|
| **Edge summon** | Hover the right edge for 300 ms; auto-retracts when you leave, with a 1.8 s cooldown after manual toggling so it does not fight you |
| **Pin / unpin** | Pin icon plus a float/push layout switch |
| **Resizable** | Drag the sidebar's left edge, 240–560 px |
| **Zero-jank animation** | The 280 ms `cubic-bezier(0.16, 1, 0.3, 1)` slide never touches the mpv viewport mid-flight |

---

## Getting started

### Requirements

- Windows 10 or 11, x64
- Node.js 18+
- **A 64-bit `libmpv` runtime** placed in `bin/` — this repository does not ship one

The runtime is a folder containing `libmpv-2.dll` plus the FFmpeg and codec DLLs it depends on (~167 MB, 135 files). Two ways to get it:

1. **Build mpv yourself** — see the build notes in [`docs/README.zh-CN.md`](docs/README.zh-CN.md) (MSYS2 CLANG64, meson + ninja, FFmpeg 9, libplacebo; ~2 min full build on a modern machine).
2. **Use a prebuilt libmpv** — any x64 mpv/libmpv distribution works, as long as `libmpv-2.dll` and its dependencies end up in `bin/`.

```
bin/
├── libmpv-2.dll          ← required
├── mpv.exe               ← optional, for standalone playback
└── *.dll                 ← FFmpeg, libass, libplacebo and friends
```

### Run from source

```bash
git clone https://github.com/13734795725zhao-rgb/aqua-lan-player.git
cd aqua-lan-player

# 1) put the mpv runtime in bin/ (see above)

# 2) install and launch
cd app
npm install
npm start
```

The repo ships an `.npmrc` pointing at the npmmirror Electron mirror; delete it if you prefer the default registry.

### Install a prebuilt package

Grab `AQUA-1.0.0-Setup.exe` from [Releases](https://github.com/13734795725zhao-rgb/aqua-lan-player/releases) — it bundles the mpv runtime, so nothing else is needed. The installer is **not code-signed**, so SmartScreen will ask once: *More info → Run anyway*.

To build the installer yourself:

```bash
cd app
npm run dist        # electron-builder → AQUA-<version>-Setup.exe
```

Diagnostics: set `AQUA_DEBUG=1` before launching to get layout and renderer logs.

---

## The hard parts

Everything below is a problem that only appears *because* the video is a native child window sitting inside a web UI. They are the reason this project exists as more than an `<video>` tag.

### Why the sidebar is a separate window

An mpv video surface is a native child window. It paints **on top of** all web content, always. No `z-index` reaches it. So any UI that must float above the video has to be its own window.

The payoff is real system acrylic: a separate window can call the DWM compositor and genuinely blur the video behind it. CSS `backdrop-filter` cannot do that — it blurs the *page*, and the video was never part of the page.

### Why there is a transparent "input glass" layer

Because the video is a native child window, the web layer never receives mouse events over it. A transparent window sits above the surface and takes them instead: mouse movement wakes the UI, hovering the right edge summons the sidebar, single click pauses, double click goes fullscreen, the wheel changes volume, and drops play files.

### The video carrier must be an *owned* top-level window

Naively passing the Electron render window's handle to mpv produces a black picture that is clearly playing audio. The cause: Electron's `Chrome_RenderWidgetHostHWND` sits above its siblings in Z-order and covers the video entirely.

The fix is to give mpv a window *owned* by the shell:

```js
SetWindowLongPtr(carrierHwnd, GWLP_HWNDPARENT, shellHwnd);
```

Windows then guarantees the carrier stays above the shell, minimises with it, and lets the glass layer above it keep receiving input. Z-order ends up: `glass → mpv surface → shell`.

### Commands are fire-and-forget

A synchronous `mpv_command` returns only after the core has executed it — and while decoding, the core is busy. The main thread stalls for tens of milliseconds, which is exactly when you click a button.

Every command now goes through `mpv_command_async`. The main process optimistically updates its state, broadcasts immediately so the UI responds instantly, then hands the command to mpv. The probe script asserts a 0 ms dispatch time.

### High-frequency updates are isolated into micro-components

`time-pos` changes every frame. If that re-rendered the whole control bar, it would compete with your clicks for render time. Instead:

- the progress bar and timecode are their own `Progress` micro-component that touches only its own nodes;
- volume and speed are low-frequency and skip the DOM entirely when the value has not changed;
- button icons rebuild only on discrete state changes;
- the main process throttles per-frame broadcasts to 20 fps and volume drags to 50 ms.

### Frosted material lives on its own layer

`backdrop-filter: blur(28px)` is GPU-expensive. If a button's hover state propagates to the container, the container recomputes the blur every frame. The material is therefore pinned to `.pill::before`, and pressed states animate `background` only — never `transform: scale()` on an ancestor of the blurred layer.

### Three libmpv instances

| Instance | Purpose | Key options |
|---|---|---|
| Player | Main picture | `wid` = carrier window, `osc=no`, all input bindings off |
| Duration probe | Reads length in the background | `vo=null ao=null` |
| Thumbnail | Hover preview on the progress bar | `vo=gpu` + its own small carrier, `absolute+exact` seeks |

### Property observation without touching `char*`

`mpv_observe_property` streams `time-pos / duration / pause / volume / mute / speed` as `MPV_EVENT_PROPERTY_CHANGE`. The event struct carries only a `const char *name` for the property — and dereferencing a `char*` through koffi crashes the process.

The workaround: give every observed property a numeric userdata id. mpv echoes it back in `mpv_event.reply_userdata` as a safe integer, and the main process maps the id back to a name. **Not a single string is ever read across the FFI boundary.**

---

## Keyboard shortcuts

| Action | Key |
|---|---|
| Play / pause | `Space` or click the picture |
| Back / forward 10 s | capsule buttons, or hold for shuttle acceleration |
| Volume | `↑` `↓`, wheel, or hover the mute button |
| Speed step / reset | `[` `]` / `\` |
| Sidebar | `Ctrl+B` or `Ctrl+\` |
| Choose folder | `Ctrl+O` |
| Picture-in-picture | `Ctrl+P` |
| Fullscreen | `F` |
| Previous / next | `Ctrl+←` / `Ctrl+→` |

---

## Project layout

```
aqua-lan-player/
├── app/
│   ├── package.json          electron-builder config, koffi dependency
│   ├── .npmrc                Electron mirror (npmmirror)
│   ├── src/
│   │   ├── main/
│   │   │   ├── main.js       state machine driving every window (2,180 lines)
│   │   │   ├── mpv.js        koffi binding to libmpv-2.dll
│   │   │   ├── win32.js      carrier window, acrylic, native window plumbing
│   │   │   ├── panels.js     menu and preview panels
│   │   │   ├── library.js    folder scanning, media metadata
│   │   │   └── store.js      persisted settings and watch progress
│   │   ├── preload/
│   │   │   └── index.js      contextBridge surface
│   │   └── renderer/
│   │       ├── shell.*       title bar and window chrome
│   │       ├── sidebar.*     frosted library sidebar (virtual list, spring scroll)
│   │       ├── controls.*    bottom control capsule
│   │       ├── glass.*       transparent input layer
│   │       ├── menu.*        context and speed menus
│   │       └── preview.*     hover preview
│   └── tools/
│       ├── probe-native.js   asserts libmpv binding, property chain, acrylic, 3rd instance
│       ├── probe-thumb.js    thumbnail instance probe
│       ├── check-renderer.js renderer smoke check
│       └── make-icon.ps1     draws icon.ico (7 sizes) with GDI+
├── build/                    icon.ico / icon.png used by electron-builder
├── bin/                      mpv runtime — NOT in the repository (see Requirements)
├── src/                      mpv source checkout — NOT in the repository
├── docs/
│   ├── README.zh-CN.md       full Chinese documentation
│   └── assets/banner.svg
├── 启动播放器.bat             dev-mode launcher (installs deps on first run)
└── 打包.bat                   one-click packaging
```

Native self-check:

```bash
cd app
npm run probe       # libmpv binding, property observation, acrylic, third instance
npm run check       # renderer smoke check
```

---

## Limitations

1. **Windows only.** The whole design leans on Win32 window ownership, DWM acrylic and native child windows. There is no macOS or Linux port, and `--wid` embedding behaves differently on X11/Wayland.
2. **The mpv runtime is not bundled in this repository.** Expect a ~167 MB download or a local build before `npm start` works.
3. **No code signing.** The installer triggers SmartScreen once.
4. **The UI is in Chinese.** The code and this README are in English.
5. **`src/` is not part of this repo.** If you want to rebuild mpv itself, clone upstream and see the build notes in the Chinese documentation.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/README.zh-CN.md`](docs/README.zh-CN.md) | Complete Chinese documentation: sidebar internals, the four sidebar pitfalls, control-bar layout rationale, mpv build environment, and environment-level notes |

---

## Contributing

Issues and pull requests are welcome.

- Keep the z-order contract intact: `glass → mpv surface → shell`. Breaking it produces a black window.
- Never call synchronous mpv commands from the main thread; use `mpv_command_async` and optimistic state updates.
- Keep the sidebar animation free of viewport resizes; resync once, on `animationend`.
- Run `npm run probe` before opening a PR.

---

## License

[MIT](LICENSE) © 2026 幻蝶

mpv is licensed under GPL-2.0-or-later / LGPL-2.1-or-later and FFmpeg under LGPL/GPL; neither is included here. If you redistribute a build that bundles their binaries, compliance with those licences is your responsibility. See the notices at the end of [`LICENSE`](LICENSE).

---

<div align="center">
<sub>Because a good engine deserves a better window.</sub>
</div>
