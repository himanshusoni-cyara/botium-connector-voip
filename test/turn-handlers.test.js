const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTurnHandler } = require('../src/turn-handlers/create-turn-handler')
const { PsstTurnHandler } = require('../src/turn-handlers/psst-turn-handler')
const { getTurnAudioFloat32, pcm16ToFloat32 } = require('../src/turn-handlers/turn-audio')
const { RmsVad } = require('../src/turn-handlers/rms-vad')
const { defaultCachePath, ONNX_FILENAME, HF_MODEL_ID } = require('../src/turn-handlers/smart-turn-model')

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

test('RmsVad fires onPause after sustained silence', () => {
  let pauses = 0
  const vad = new RmsVad({ minSilenceMs: 60, frameMs: 30, rmsThreshold: 100 })
  vad.onPause(() => { pauses += 1 })
  const sampleRate = 16000
  const loud = Buffer.alloc(sampleRate * 2)
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(8000, i)
  vad.feedPcm16(loud, sampleRate, 1)
  const quiet = Buffer.alloc(sampleRate * 2)
  vad.feedPcm16(quiet, sampleRate, 1)
  vad.feedPcm16(quiet, sampleRate, 1)
  vad.feedPcm16(quiet, sampleRate, 1)
  assert.equal(pauses, 1)
})
