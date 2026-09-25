const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const pkgDir = path.resolve(__dirname, '..')

test('bundled models resolve from package root (src)', () => {
  const { bundledModelPath } = require('../src/package-assets')
  const ced = bundledModelPath('ced-tiny.int8.onnx')
  const ten = bundledModelPath('ten-vad.int8.onnx')
  assert.ok(ced.includes(`${path.sep}assets${path.sep}models${path.sep}ced-tiny.int8.onnx`))
  assert.ok(ten.includes(`${path.sep}assets${path.sep}models${path.sep}ten-vad.int8.onnx`))
  assert.ok(fs.existsSync(ced), `missing ${ced}`)
  assert.ok(fs.existsSync(ten), `missing ${ten}`)
})

test('CED resolve works after dist build', async () => {
  const distCjs = path.join(pkgDir, 'dist/botium-connector-voip-cjs.js')
  if (!fs.existsSync(distCjs)) {
    return
  }
  const { resolveCedTinyModelPath } = require(distCjs)
  if (!resolveCedTinyModelPath) {
    const ced = require('../src/audio-tagging/ced-tiny-model')
    const cedPath = await ced.resolveCedTinyModelPath({
      caps: {},
      Capabilities: { VOIP_CED_TINY_MODEL_PATH: 'VOIP_CED_TINY_MODEL_PATH' }
    })
    assert.ok(cedPath && fs.existsSync(cedPath))
    return
  }
  const cedPath = await resolveCedTinyModelPath({
    caps: {},
    Capabilities: { VOIP_CED_TINY_MODEL_PATH: 'VOIP_CED_TINY_MODEL_PATH' }
  })
  assert.ok(cedPath && fs.existsSync(cedPath))
})
