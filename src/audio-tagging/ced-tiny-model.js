const fs = require('fs')
const { bundledModelPath: packageBundledModelPath } = require('../package-assets')

const ONNX_FILENAME = 'ced-tiny.int8.onnx'
const LABELS_FILENAME = 'class_labels_indices.csv'
const HF_REPO = 'k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19'
const DOWNLOAD_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`

const bundledModelPath = () => packageBundledModelPath(ONNX_FILENAME)
const bundledLabelsPath = () => packageBundledModelPath(LABELS_FILENAME)

const configuredOverridePath = (caps, Capabilities) => {
  const key = Capabilities && Capabilities.VOIP_CED_TINY_MODEL_PATH
  if (!key || !caps) return null
  const p = caps[key]
  return p && fs.existsSync(p) ? p : null
}

async function resolveCedTinyModelPath ({ caps, Capabilities, log }) {
  const override = configuredOverridePath(caps, Capabilities)
  if (override) return override
  const bundled = bundledModelPath()
  if (fs.existsSync(bundled)) return bundled
  if (log) {
    log('ced_tiny_model_missing', { bundled, hint: 'Run prefetch or vendor ced-tiny.int8.onnx' })
  }
  return null
}

function loadLabelIndex (labelsPath) {
  if (!labelsPath || !fs.existsSync(labelsPath)) {
    return { speech: 0, music: 137 }
  }
  const text = fs.readFileSync(labelsPath, 'utf8')
  let speech = 0
  let music = 137
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+),[^,]*,"([^"]*)"/)
    if (!m) continue
    const idx = parseInt(m[1], 10)
    const name = m[2].trim()
    if (name === 'Speech') speech = idx
    if (name === 'Music') music = idx
  }
  return { speech, music }
}

module.exports = {
  ONNX_FILENAME,
  LABELS_FILENAME,
  HF_REPO,
  DOWNLOAD_BASE,
  bundledModelPath,
  bundledLabelsPath,
  configuredOverridePath,
  resolveCedTinyModelPath,
  loadLabelIndex
}
