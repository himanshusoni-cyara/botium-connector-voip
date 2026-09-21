const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

// Must match @micdrop/smart-turn (mel features → input_features). The soniqo int8
// checkpoint uses raw waveform input "audio" and is not compatible with micdrop.
const HF_MODEL_ID = 'pipecat-ai/smart-turn-v3'
const HF_REVISION = process.env.BOTIUM_SMART_TURN_HF_REVISION || 'main'
const ONNX_FILENAME = 'smart-turn-v3.2-cpu.onnx'

let downloadPromise = null

const defaultCacheDir = () => {
  if (process.env.BOTIUM_SMART_TURN_CACHE_DIR) {
    return process.env.BOTIUM_SMART_TURN_CACHE_DIR
  }
  return path.join(os.homedir(), '.cache', 'botium', 'smart-turn-v3.2-cpu')
}

const defaultCachePath = () => path.join(defaultCacheDir(), ONNX_FILENAME)

const configuredOverridePath = (caps, Capabilities) => {
  const fromCap = caps && Capabilities && caps[Capabilities.VOIP_SMART_TURN_MODEL_PATH]
  if (fromCap && String(fromCap).trim()) return String(fromCap).trim()
  if (process.env.BOTIUM_SMART_TURN_MODEL_PATH) return String(process.env.BOTIUM_SMART_TURN_MODEL_PATH).trim()
  if (process.env.VOIP_SMART_TURN_MODEL_PATH) return String(process.env.VOIP_SMART_TURN_MODEL_PATH).trim()
  return null
}

const downloadOnnx = async ({ destPath, log }) => {
  if (fs.existsSync(destPath)) return destPath
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
  const url = `https://huggingface.co/${HF_MODEL_ID}/resolve/${HF_REVISION}/${ONNX_FILENAME}`
  const tempPath = `${destPath}.${process.pid}.${Date.now()}.tmp`
  log('smart_turn_model_download_started', {
    modelId: HF_MODEL_ID,
    revision: HF_REVISION,
    relativePath: ONNX_FILENAME,
    destination: destPath,
    url
  })
  try {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath))
    try {
      await fs.promises.rename(tempPath, destPath)
    } catch (err) {
      if (!fs.existsSync(destPath)) throw err
      await fs.promises.rm(tempPath, { force: true })
    }
    const stat = await fs.promises.stat(destPath)
    log('smart_turn_model_download_finished', {
      modelId: HF_MODEL_ID,
      revision: HF_REVISION,
      relativePath: ONNX_FILENAME,
      bytes: stat.size,
      destination: destPath
    })
    return destPath
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true })
    throw new Error(`Downloading ${ONNX_FILENAME} failed: ${err.message}`)
  }
}

/**
 * Resolve ONNX path: optional cap/env override, else cached auto-download (pipecat cpu ONNX).
 */
const resolveSmartTurnModelPath = async ({ caps, Capabilities, log = () => {} }) => {
  const override = configuredOverridePath(caps, Capabilities)
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`Smart Turn model not found at configured path: ${override}`)
    }
    return override
  }
  const destPath = defaultCachePath()
  if (fs.existsSync(destPath)) return destPath
  if (!downloadPromise) {
    downloadPromise = downloadOnnx({ destPath, log }).finally(() => {
      downloadPromise = null
    })
  }
  return downloadPromise
}

module.exports = {
  HF_MODEL_ID,
  HF_REVISION,
  ONNX_FILENAME,
  defaultCacheDir,
  defaultCachePath,
  configuredOverridePath,
  resolveSmartTurnModelPath
}
