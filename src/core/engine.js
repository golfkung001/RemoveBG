'use strict';
/* Runs the model: one ONNX session, reused for every photo. */
const ort = require('onnxruntime-node');
const cutout = require('./cutout');

class Engine {
  constructor(session, provider) { this.session = session; this.provider = provider; }

  /* useGpu tries DirectML (any DirectX 12 graphics card on Windows) and
     falls back to the processor when it is not available. */
  static async load(modelPath, { useGpu = false, threads = 0 } = {}) {
    /* enableMemPattern off: with it on, the second photo makes ONNX Runtime
       ask for one huge block that Electron's memory allocator refuses, and
       the process stops. Memory use is the same either way. */
    const base = { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
    if (threads > 0) base.intraOpNumThreads = threads;
    if (useGpu && process.platform === 'win32') {
      try {
        const s = await ort.InferenceSession.create(modelPath, { ...base, executionProviders: ['dml'] });
        return new Engine(s, 'gpu');
      } catch { /* fall back to the processor */ }
    }
    const s = await ort.InferenceSession.create(modelPath, { ...base, executionProviders: ['cpu'] });
    return new Engine(s, 'cpu');
  }

  /* Photo file -> 8-bit mask at the photo's size, plus the decoded photo. */
  async mask(file) {
    const img = await cutout.readImage(file);
    const input = new ort.Tensor('float32', await cutout.toTensor(img), [1, 3, cutout.SIZE, cutout.SIZE]);
    const out = await this.session.run({ [this.session.inputNames[0]]: input });
    const logits = out[this.session.outputNames[0]];
    const alpha = await cutout.toMask(logits.data, img.width, img.height);
    for (const t of Object.values(out)) t.dispose?.();
    input.dispose?.();
    return { img, alpha };
  }

  /* Photo file -> encoded cut-out (see cutout.render for the options). */
  async process(file, options) {
    const { img, alpha } = await this.mask(file);
    cutout.snapAlpha(alpha);
    const light = await cutout.isLightBackground(img);
    return cutout.render(img, alpha, options, light);
  }

  async close() { await this.session?.release?.(); this.session = null; }
}

module.exports = { Engine };
