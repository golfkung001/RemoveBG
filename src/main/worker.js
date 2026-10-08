'use strict';
/* The AI runs here, in its own process, so the window never freezes and
   running out of memory cannot take the app down with it.
   Started by Electron's utilityProcess (or child_process.fork in tests). */
const fs = require('node:fs');
const { Engine } = require('../core/engine');

const port = process.parentPort;
const send = m => (port ? port.postMessage(m) : process.send(m));
const listen = fn => (port ? port.on('message', e => fn(e.data)) : process.on('message', fn));

let engine = null, modelPath = '', queue = Promise.resolve();

async function handle(m) {
  if (m.type === 'load') {
    try {
      await engine?.close();
      modelPath = m.modelPath;
      engine = await Engine.load(m.modelPath, { useGpu: !!m.useGpu });
      send({ type: 'loaded', provider: engine.provider });
    } catch (e) {
      engine = null;
      send({ type: 'error', stage: 'load', message: String(e.message || e) });
    }
  } else if (m.type === 'job') {
    const t = Date.now();
    try {
      if (!engine) throw Object.assign(new Error('The AI model is not loaded.'), { code: 'NO_MODEL' });
      send({ type: 'stage', id: m.id, stage: 'ai' });
      let r;
      try {
        r = await engine.process(m.input, m.options);
      } catch (e) {
        /* a graphics card that loaded the model but cannot run it: use the processor from now on */
        if (engine.provider !== 'gpu' || e.code === 'EMPTY') throw e;
        await engine.close();
        engine = await Engine.load(modelPath, { useGpu: false });
        send({ type: 'loaded', provider: engine.provider });
        r = await engine.process(m.input, m.options);
      }
      send({ type: 'stage', id: m.id, stage: 'save' });
      const tmp = m.output + '.saving';
      fs.writeFileSync(tmp, r.buffer);
      fs.renameSync(tmp, m.output);
      send({ type: 'done', id: m.id, output: m.output, width: r.width, height: r.height, ms: Date.now() - t });
    } catch (e) {
      send({ type: 'failed', id: m.id, code: e.code || '', message: String(e.message || e) });
    }
  } else if (m.type === 'quit') {
    await engine?.close();
    process.exit(0);
  }
}

/* one message at a time, in order */
listen(m => { queue = queue.then(() => handle(m)); });
send({ type: 'started', pid: process.pid });
