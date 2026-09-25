const { test } = require('node:test')
const assert = require('node:assert/strict')
const ort = require('onnxruntime-node')
const path = require('path')
const { computeCedFeats } = require('../src/audio-tagging/ced-tiny-features')
const { bundledModelPath } = require('../src/package-assets')

test('computeCedFeats produces ONNX-compatible [1, 64, T] tensor', async () => {
  const waveform = new Float32Array(16000)
  for (let i = 0; i < waveform.length; i++) {
    waveform[i] = 0.001 * Math.sin(i / 40)
  }
  const feats = computeCedFeats(waveform)
  assert.ok(feats)
  assert.equal(feats.dims[0], 1)
  assert.equal(feats.dims[1], 64)
  assert.ok(feats.dims[2] > 0)

  const modelPath = bundledModelPath('ced-tiny.int8.onnx')
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  const out = await session.run({
    feats: new ort.Tensor('float32', feats.data, feats.dims)
  })
  const prob = out[session.outputNames[0]].data
  assert.equal(prob.length, 527)
})
