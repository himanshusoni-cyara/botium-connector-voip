const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTurnHandler } = require('../src/turn-handlers/create-turn-handler')
const { PsstTurnHandler } = require('../src/turn-handlers/psst-turn-handler')
const { getTurnAudioFloat32, pcm16ToFloat32 } = require('../src/turn-handlers/turn-audio')
const { defaultCachePath, ONNX_FILENAME, HF_MODEL_ID } = require('../src/turn-handlers/smart-turn-model')
const {
  bundledModelPath,
  TEN_VAD_DOWNLOAD_URL,
  ONNX_FILENAME: TEN_VAD_FILENAME,
  parseTenVadMetadata
} = require('../src/turn-handlers/ten-vad-model')

const Capabilities = {
  VOIP_STT_TURN_HANDLER: 'VOIP_STT_TURN_HANDLER',
  VOIP_STT_MESSAGE_HANDLING: 'VOIP_STT_MESSAGE_HANDLING',
  VOIP_SMART_TURN_THRESHOLD: 'VOIP_SMART_TURN_THRESHOLD',
  VOIP_SMART_TURN_MODEL_PATH: 'VOIP_SMART_TURN_MODEL_PATH',
  VOIP_SMART_TURN_MAX_SILENCE_MS: 'VOIP_SMART_TURN_MAX_SILENCE_MS',
  VOIP_SMART_TURN_VAD_MIN_SILENCE_MS: 'VOIP_SMART_TURN_VAD_MIN_SILENCE_MS',
  VOIP_SMART_TURN_INFERENCE_TIMEOUT_MS: 'VOIP_SMART_TURN_INFERENCE_TIMEOUT_MS',
  VOIP_SMART_TURN_MIN_COMMIT_DELAY_MS: 'VOIP_SMART_TURN_MIN_COMMIT_DELAY_MS'
}

test('createTurnHandler defaults to PSST', () => {
  const flushed = []
  const ctx = {
    botMsgs: [{ sourceData: { data: { start: 0, end: 1 } } }],
    caps: { [Capabilities.VOIP_STT_TURN_HANDLER]: 'PSST' },
    isJoinMethod: () => true,
    getEffectiveJoinTimeoutMs: () => 500,
    getPsstLatencyGraceMs: () => 0,
    isLastFinalNaturalEnd: () => true,
    sessionId: 's1',
    eventEmitter: null,
    Capabilities,
    _info: () => {},
    debug: () => {},
    markReplyTrace: () => {},
    stopCalled: false,
    flushBufferedBotMsgs: () => flushed.push(1)
  }
  const handler = createTurnHandler(ctx.caps, Capabilities, ctx)
  assert.ok(handler instanceof PsstTurnHandler)
})

test('pcm16ToFloat32 scales samples', () => {
  const pcm = Buffer.alloc(4)
  pcm.writeInt16LE(16384, 0)
  pcm.writeInt16LE(-16384, 2)
  const f = pcm16ToFloat32(pcm, 1)
  assert.equal(f.length, 2)
  assert.ok(Math.abs(f[0] - 0.5) < 0.01)
})

test('getTurnAudioFloat32 slices stream by STT bounds', () => {
  const sampleRate = 8000
  const pcm = Buffer.alloc(8000 * 2)
  for (let i = 0; i < pcm.length; i += 2) {
    pcm.writeInt16LE(1000, i)
  }
  const audioStream = {
    format: { sampleRate, channels: 1, bitsPerSample: 16 },
    pcmParts: [pcm],
    totalBytes: pcm.length
  }
  const botMsgs = [{ sourceData: { data: { start: 0, end: 0.5 } } }]
  const audio = getTurnAudioFloat32(audioStream, botMsgs, 0.5)
  assert.ok(audio)
  assert.equal(audio.sampleRate, 8000)
  assert.ok(audio.samples.length > 0)
})

test('smart turn default cache uses pipecat cpu onnx for @micdrop/smart-turn', () => {
  assert.equal(ONNX_FILENAME, 'smart-turn-v3.2-cpu.onnx')
  assert.equal(HF_MODEL_ID, 'pipecat-ai/smart-turn-v3')
  assert.ok(defaultCachePath().endsWith('smart-turn-v3.2-cpu.onnx'))
})

test('ten-vad bundles sherpa int8 onnx with attributed download URL', () => {
  assert.equal(TEN_VAD_FILENAME, 'ten-vad.int8.onnx')
  assert.ok(TEN_VAD_DOWNLOAD_URL.includes('sherpa-onnx/releases/download/asr-models/ten-vad.int8.onnx'))
  const modelPath = bundledModelPath()
  assert.ok(modelPath.includes('assets/models/ten-vad.int8.onnx'))
  assert.ok(require('fs').existsSync(modelPath))
})

test('parseTenVadMetadata reads sherpa-packaged model vectors', () => {
  const modelPath = bundledModelPath()
  if (!require('fs').existsSync(modelPath)) return
  const meta = parseTenVadMetadata(modelPath)
  assert.equal(meta.mean.length, 41)
  assert.equal(meta.window.length, 768)
})
