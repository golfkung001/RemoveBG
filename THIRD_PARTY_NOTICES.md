# Third-party software and models

RemoveBG bundles or downloads the following. Their license texts ship inside the
installed app (`resources/app.asar.unpacked/node_modules/*/LICENSE*`,
`LICENSE.electron.txt`, `LICENSES.chromium.html`).

| Component | Use | License |
|---|---|---|
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | The AI model (general and general-lite weights) | MIT |
| [rembg](https://github.com/danielgatis/rembg) | ONNX exports of BiRefNet, downloaded from its GitHub releases on first run; pre/post-processing follows its BiRefNet session | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`) | Runs the model (CPU; DirectML on Windows) | MIT |
| DirectML (`DirectML.dll`, shipped inside `onnxruntime-node`) | Optional graphics card acceleration | See the license in the onnxruntime-node package |
| [sharp](https://github.com/lovell/sharp) | Reading, resizing and writing images | Apache-2.0 |
| [libvips](https://github.com/libvips/libvips) (inside `@img/sharp-win32-x64`) | Image processing library used by sharp | LGPL-3.0-or-later |
| [Electron](https://github.com/electron/electron) | Application shell | MIT (Chromium components: see `LICENSES.chromium.html`) |

The model files are not part of this repository or the installer; the app
downloads them from the rembg GitHub releases and checks their SHA-256.
