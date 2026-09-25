const { test } = require('node:test')
const assert = require('node:assert/strict')
const { NamoTurnGate, TURN_SOFT_ENDED } = require('../src/turn-handlers/namo-turn-gate')

const Capabilities = {
  VOIP_NAMO_EOU_THRESHOLD: 'VOIP_NAMO_EOU_THRESHOLD',
  VOIP_NAMO_MIN_WAIT_MS: 'VOIP_NAMO_MIN_WAIT_MS',
  VOIP_NAMO_MAX_WAIT_MS: 'VOIP_NAMO_MAX_WAIT_MS',
  VOIP_NAMO_QUESTION_FLUSH_MS: 'VOIP_NAMO_QUESTION_FLUSH_MS',
  VOIP_NAMO_EMIT_STABLE_MS: 'VOIP_NAMO_EMIT_STABLE_MS',
  VOIP_NAMO_GAP_OUTLIER_FACTOR: 'VOIP_NAMO_GAP_OUTLIER_FACTOR',
  VOIP_NAMO_REOPEN_MS: 'VOIP_NAMO_REOPEN_MS',
  VOIP_NAMO_DTMF_ECHO_MS: 'VOIP_NAMO_DTMF_ECHO_MS',
  VOIP_NAMO_VAD_SHORT_SEGMENT_MERGE_MS: 'VOIP_NAMO_VAD_SHORT_SEGMENT_MERGE_MS',
  VOIP_NAMO_VAD_ENABLE: 'VOIP_NAMO_VAD_ENABLE',
  VOIP_STT_MESSAGE_HANDLING_DELIMITER: 'VOIP_STT_MESSAGE_HANDLING_DELIMITER'
}

const makeGate = (overrides = {}) => {
  const messages = [{ messageText: 'Hello', sourceData: { data: { start: 0, end: 1 } } }]
  const commits = []
  const detector = {
    predict: async (text) => ({
      eouProbability: text.includes('complete') ? 0.95 : 0.2,
      incompleteProbability: 0.8,
      inferenceMs: 1
    })
  }
  let vadActive = false
  const gate = new NamoTurnGate({
    caps: {
      [Capabilities.VOIP_NAMO_EOU_THRESHOLD]: 0.85,
      [Capabilities.VOIP_NAMO_MIN_WAIT_MS]: 0,
      [Capabilities.VOIP_NAMO_MAX_WAIT_MS]: 30000,
      [Capabilities.VOIP_NAMO_REOPEN_MS]: 50,
      [Capabilities.VOIP_NAMO_EMIT_STABLE_MS]: 0,
      [Capabilities.VOIP_NAMO_VAD_ENABLE]: true,
      [Capabilities.VOIP_STT_MESSAGE_HANDLING_DELIMITER]: ' '
    },
    Capabilities,
    detector,
    getMessages: () => messages,
    commitFlush: (msg) => commits.push(msg),
    getVadSpeechActive: () => vadActive,
    getVadEnabled: () => true,
    getLastVadSpeechEndAt: () => null,
    setLastVadSpeechEndAt: () => {},
    eventEmitter: null,
    sessionId: 'test',
    _info: () => {},
    onInferenceError: () => {},
    ...overrides
  })
  return { gate, messages, commits, setVadActive: (v) => { vadActive = v } }
}

test('reopen during soft_ended keeps a single commit after speech resumes', async () => {
  const { gate, messages, commits, setVadActive } = makeGate()
  gate.onFinalBuffered()
  setVadActive(false)
  gate._softEndTurn('model_complete', { eouProbability: 0.9, incompleteProbability: 0.1, inferenceMs: 1 })
  assert.equal(gate.turnState, TURN_SOFT_ENDED)
  messages.push({ messageText: 'world', sourceData: { data: { start: 1, end: 2 } } })
  setVadActive(true)
  gate.onVadSpeechStart()
  assert.equal(gate.turnState, 'buffering')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(commits.length, 0)
})

test('shouldSuppressSttText drops digit-only echo after agent DTMF', () => {
  const { gate } = makeGate()
  gate.noteAgentDtmf()
  assert.equal(gate.shouldSuppressSttText('4012'), true)
  assert.equal(gate.shouldSuppressSttText('Please wait'), false)
})
