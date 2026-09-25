const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const DEFAULT_MODEL_ID = 'videosdk-live/Namo-Turn-Detector-v1-English'
const DEFAULT_MODEL_REVISION = '4dcc9713be5071ef43e510f72b1eefcb2f99cb04'
const MODEL_FILENAME = 'model_quant.onnx'

const sharedModels = new Map()

const safePathPart = value => String(value).replace(/[^a-zA-Z0-9._-]+/g, '--')

const softmax = values => {
  const max = Math.max(...values)
  const exps = values.map(value => Math.exp(value - max))
  const sum = exps.reduce((acc, value) => acc + value, 0)
  return exps.map(value => value / sum)
}

const toInt64Array = data => {
  if (data instanceof BigInt64Array) return data
  return BigInt64Array.from(data, value => typeof value === 'bigint' ? value : BigInt(value))
}

const downloadModel = async ({ modelId, revision, cacheDir, log }) => {
  const modelDir = path.join(cacheDir, safePathPart(modelId), safePathPart(revision))
  const modelPath = path.join(modelDir, MODEL_FILENAME)
  if (fs.existsSync(modelPath)) {
    return modelPath
  }

  await fs.promises.mkdir(modelDir, { recursive: true })
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/${MODEL_FILENAME}`
  const tempPath = `${modelPath}.${process.pid}.${Date.now()}.tmp`
  log('namo_model_download_started', { modelId, revision, destination: modelPath })

  try {
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath))
    try {
      await fs.promises.rename(tempPath, modelPath)
    } catch (err) {
      if (!fs.existsSync(modelPath)) throw err
      await fs.promises.rm(tempPath, { force: true })
    }
    const stat = await fs.promises.stat(modelPath)
    log('namo_model_download_finished', { modelId, revision, bytes: stat.size })
    return modelPath
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true })
    throw new Error(`Downloading Namo model failed: ${err.message}`)
  }
}

const loadModel = async (options) => {
  const startedAt = Date.now()
  const {
    modelId,
    revision,
    modelPath: configuredModelPath,
    cacheDir,
    log
  } = options

  log('namo_model_loading', {
    modelId,
    revision,
    modelSource: configuredModelPath ? 'local' : 'huggingface',
    cacheDir
  })

  const [{ AutoTokenizer, env }, ort] = await Promise.all([
    import('@huggingface/transformers'),
    Promise.resolve().then(() => require('onnxruntime-node'))
  ])

  env.cacheDir = cacheDir
  const modelPath = configuredModelPath
    ? path.resolve(configuredModelPath)
    : await downloadModel({ modelId, revision, cacheDir, log })

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Namo model does not exist at ${modelPath}`)
  }

  const tokenizerDir = path.dirname(modelPath)
  const hasLocalTokenizer = fs.existsSync(path.join(tokenizerDir, 'tokenizer.json')) ||
    fs.existsSync(path.join(tokenizerDir, 'tokenizer_config.json'))
  const tokenizerSource = hasLocalTokenizer ? tokenizerDir : modelId
  const tokenizerOptions = hasLocalTokenizer ? {} : { revision }

  const [tokenizer, session] = await Promise.all([
    AutoTokenizer.from_pretrained(tokenizerSource, tokenizerOptions),
    ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    })
  ])

  log('namo_model_ready', {
    modelId,
    revision,
    modelPath,
    tokenizerSource: hasLocalTokenizer ? 'local' : 'huggingface',
    loadMs: Date.now() - startedAt,
    inputs: session.inputNames,
    outputs: session.outputNames
  })

  return { tokenizer, session, ort }
}

class NamoDetector {
  constructor ({
    modelId = DEFAULT_MODEL_ID,
    revision = DEFAULT_MODEL_REVISION,
    modelPath = null,
    cacheDir = process.env.BOTIUM_NAMO_CACHE_DIR || path.join(os.homedir(), '.cache', 'botium', 'namo'),
    maxLength = 512,
    log = () => {}
  } = {}) {
    this.options = { modelId, revision, modelPath, cacheDir, maxLength, log }
    this.model = null
  }

  async init () {
    const key = JSON.stringify({
      modelId: this.options.modelId,
      revision: this.options.revision,
      modelPath: this.options.modelPath,
      cacheDir: this.options.cacheDir
    })
    if (!sharedModels.has(key)) {
      const loading = loadModel(this.options).catch(err => {
        sharedModels.delete(key)
        throw err
      })
      sharedModels.set(key, loading)
    }
    this.model = await sharedModels.get(key)
  }

  async predict (text) {
    if (!this.model) throw new Error('Namo model is not initialized')
    const startedAt = Date.now()
    const encoded = await this.model.tokenizer(String(text || '').trim(), {
      truncation: true,
      max_length: this.options.maxLength
    })

    const inputIds = encoded.input_ids
    const attentionMask = encoded.attention_mask
    const feeds = {
      input_ids: new this.model.ort.Tensor('int64', toInt64Array(inputIds.data), inputIds.dims),
      attention_mask: new this.model.ort.Tensor('int64', toInt64Array(attentionMask.data), attentionMask.dims)
    }
    const output = await this.model.session.run(feeds)
    const logitsTensor = output[this.model.session.outputNames[0]]
    const logits = Array.from(logitsTensor.data)
    if (logits.length < 2) {
      throw new Error(`Unexpected Namo output with ${logits.length} logits`)
    }
    const probabilities = softmax(logits.slice(0, 2))
    return {
      incompleteProbability: probabilities[0],
      eouProbability: probabilities[1],
      predictedComplete: probabilities[1] >= probabilities[0],
      inferenceMs: Date.now() - startedAt
    }
  }
}

module.exports = {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  NamoDetector
}
