const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  speechEndAtMsFromFinal,
  computeConnectorDeadlineMs,
  applyOtsLatencyProfile
} = require('../src/reply-budget')

const Capabilities = {
  VOIP_REPLY_BUDGET_MS: 'VOIP_REPLY_BUDGET_MS',
  VOIP_REPLY_COACH_RESERVE_MS: 'VOIP_REPLY_COACH_RESERVE_MS',
  VOIP_REPLY_WIRE_RESERVE_MS: 'VOIP_REPLY_WIRE_RESERVE_MS',
  VOIP_OTS_LATENCY_PROFILE: 'VOIP_OTS_LATENCY_PROFILE',
  VOIP_STT_MESSAGE_HANDLING: 'VOIP_STT_MESSAGE_HANDLING',
  VOIP_NAMO_REOPEN_MS: 'VOIP_NAMO_REOPEN_MS',
  VOIP_NAMO_EMIT_STABLE_MS: 'VOIP_NAMO_EMIT_STABLE_MS',
  VOIP_NAMO_MAX_WAIT_MS: 'VOIP_NAMO_MAX_WAIT_MS',
  VOIP_NAMO_MIN_WAIT_MS: 'VOIP_NAMO_MIN_WAIT_MS',
  VOIP_CED_ENABLE: 'VOIP_CED_ENABLE'
}

const Defaults = {
  [Capabilities.VOIP_NAMO_REOPEN_MS]: 800,
  [Capabilities.VOIP_NAMO_MAX_WAIT_MS]: 8000
}

test('speechEndAtMsFromFinal derives wall clock from recording lag', () => {
  const at = speechEndAtMsFromFinal({
    finalAtMs: 10_000,
    recordingAtSttFinalSec: 12,
    speechEndSec: 11.5
  })
  assert.equal(at, 9500)
})

test('computeConnectorDeadlineMs respects reserves and floor', () => {
  const caps = {
    [Capabilities.VOIP_REPLY_BUDGET_MS]: 5000,
    [Capabilities.VOIP_REPLY_COACH_RESERVE_MS]: 2500,
    [Capabilities.VOIP_REPLY_WIRE_RESERVE_MS]: 800
  }
  assert.equal(computeConnectorDeadlineMs(caps, Capabilities), 1700)
})

test('applyOtsLatencyProfile sets unset latency caps', () => {
  const merged = { [Capabilities.VOIP_OTS_LATENCY_PROFILE]: true }
  applyOtsLatencyProfile(merged, {}, Capabilities, Defaults)
  assert.equal(merged[Capabilities.VOIP_REPLY_BUDGET_MS], 5000)
  assert.equal(merged[Capabilities.VOIP_NAMO_REOPEN_MS], 800)
  assert.equal(merged[Capabilities.VOIP_NAMO_MAX_WAIT_MS], 3500)
  assert.equal(merged[Capabilities.VOIP_STT_MESSAGE_HANDLING], 'NAMO')
})

test('applyOtsLatencyProfile keeps user overrides', () => {
  const user = { [Capabilities.VOIP_NAMO_MAX_WAIT_MS]: 9000 }
  const merged = Object.assign({}, Defaults, { [Capabilities.VOIP_OTS_LATENCY_PROFILE]: true }, user)
  applyOtsLatencyProfile(merged, user, Capabilities, Defaults)
  assert.equal(merged[Capabilities.VOIP_NAMO_MAX_WAIT_MS], 9000)
})
