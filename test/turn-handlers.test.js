const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTurnHandler } = require('../src/turn-handlers/create-turn-handler')
const { NamoTurnHandler } = require('../src/turn-handlers/namo-turn-handler')
const { getTurnAudioFloat32, pcm16ToFloat32 } = require('../src/turn-handlers/turn-audio')
const {
  bundledModelPath,
  TEN_VAD_DOWNLOAD_URL,
  ONNX_FILENAME: TEN_VAD_FILENAME,
  parseTenVadMetadata
} = require('../src/turn-handlers/ten-vad-model')

const Capabilities = {
  VOIP_STT_TURN_HANDLER: 'VOIP_STT_TURN_HANDLER',
  VOIP_STT_MESSAGE_HANDLING: 'VOIP_STT_MESSAGE_HANDLING',
  VOIP_NAMO_EOU_THRESHOLD: 'VOIP_NAMO_EOU_THRESHOLD',
  VOIP_NAMO_MODEL_ID: 'VOIP_NAMO_MODEL_ID',
  VOIP_NAMO_MODEL_REVISION: 'VOIP_NAMO_MODEL_REVISION',
  VOIP_NAMO_MODEL_PATH: 'VOIP_NAMO_MODEL_PATH',
  VOIP_NAMO_CACHE_DIR: 'VOIP_NAMO_CACHE_DIR',
  VOIP_NAMO_FALLBACK_HANDLING: 'VOIP_NAMO_FALLBACK_HANDLING',
  VOIP_NAMO_VAD_ENABLE: 'VOIP_NAMO_VAD_ENABLE',
  VOIP_STT_MESSAGE_HANDLING_DELIMITER: 'VOIP_STT_MESSAGE_HANDLING_DELIMITER'
}

test('createTurnHandler always returns NamoTurnHandler', () => {
  const ctx = {
    botMsgs: [],
    caps: { [Capabilities.VOIP_STT_TURN_HANDLER]: 'PSST' },
    sessionId: 's1',
    eventEmitter: null,
    Capabilities,
    _info: () => {},
    debug: () => {},
    markReplyTrace: () => {},
    commitNamoFlush: () => {},
    flushBufferedBotMsgs: () => {},
    isJoinMethod: () => true
  }
  const handler = createTurnHandler(ctx.caps, Capabilities, ctx)
  assert.ok(handler instanceof NamoTurnHandler)
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
