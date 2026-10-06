# PLOP
**[A fully-featured Falling-Sand game powered by WebAssembly!](https://nanamitm.github.io/plop/)**

[![haii~ i hope u like tha thing :\]](https://nanamitm.github.io/plop/logo.png)](https://nanamitm.github.io/plop/)

# Background
## What?
PLOP follows a tradition of games called "Falling-Sand games". A host of independently developed and published games, usually distributed for free in the form of Web-Apps. They allow the player to paint different elements onto the playing field and lets them discover interesting interactions and emerging behavior. Creative and imaginative interplay with the different systems of the sandbox make up the gameplay, instead of story progression or other external motivators.

## Mechanics
PLOP makes use of two intersecting systems: a cellular-automaton and a fluid simulation. Elements are portrayed as pixels, or "cells", on a grid. Each cell interacts with its direct neighbors based on their types and produces unique behavior. Fire will set flammable material like wood ablaze. Hot cells will evaporate water, creating steam that rises to the top of the canvas, only to later rain down again. Supplementary to the cellular-automaton, a fluid simulation approximates wind and allows temperature changes to propagate.

# Fluid resolution

The fluid grid scales automatically with the canvas: 75² below 600 pixels,
150² from 600 pixels, and 300² from 1200 pixels.

You can manually select the fluid resolution by appending one of these query
parameters to the URL:

- [`?fluid=75`](https://nanamitm.github.io/plop/?fluid=75)
- [`?fluid=150`](https://nanamitm.github.io/plop/?fluid=150)
- [`?fluid=300`](https://nanamitm.github.io/plop/?fluid=300)

The manual setting overrides the automatic choice when the requested fluid
grid fits inside the canvas. Saved states retain their fluid resolution, and
states created by the previous fixed 75² format remain loadable.

# Building

Required Dev-Dependencies:
- clang
- uglifyjs

```
$ git clone https://github.com/Caltrop256/plop
```

```
$ cd plop
```

```
$ make
```

# Regression tests

With Node.js and clang installed, run:

```
node tests/regressions.cjs
node tests/regressions.cjs --sanitize
node tests/webgpu-regressions.cjs
```

The tests cover saved-state validation and compatibility, element lifetimes,
conductivity at empty cells and edges, pump discharge, particle cleanup and
rendering, and memory growth during asynchronous GPU readback. Test builds are
written to the ignored `work/tests` directory. The sanitizer run traps NULL
accesses without requiring a separate runtime library.

For an optional Chromium integration check, build the site first, then run
`node tests/browser-smoke.cjs` with Node.js 22 or newer. Set `PLOP_BROWSER` to
the Chromium executable if it is not at the default Windows Chrome path.
The check requires a WebGPU adapter and also exercises the Canvas2D fallback.

# License

This project is licensed under the [GNU General Public License v3.0](https://github.com/nanamitm/plop/blob/master/LICENSE). You may copy, distribute, and modify the software as long as you track changes/dates in the source files. Any modifications to this project must be made available under the GPL along with build & install instructions.
