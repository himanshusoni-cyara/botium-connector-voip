const { test } = require('node:test')
const assert = require('node:assert/strict')
const { waitForOutboundAllowed } = require('../src/inbound/outbound-gate')
const { createIvrDeliveryController } = require('../src/inbound/ivr-delivery-controller')

const Capabilities = {
  VOIP_STT_TURN_HANDLER: 'VOIP_STT_TURN_HANDLER',
  VOIP_IVR_DEFER_DELIVERY_ENABLE: 'VOIP_IVR_DEFER_DELIVERY_ENABLE',
  VOIP_IVR_DELIVERY_QUIET_MS: 'VOIP_IVR_DELIVERY_QUIET_MS',
  VOIP_IVR_JOIN_TIMEOUT_MS: 'VOIP_IVR_JOIN_TIMEOUT_MS',
  VOIP_IVR_DELIVERY_MAX_WAIT_MS: 'VOIP_IVR_DELIVERY_MAX_WAIT_MS',
  VOIP_IVR_MAX_JOIN_CHUNKS: 'VOIP_IVR_MAX_JOIN_CHUNKS'
}

test('waitForOutboundAllowed passes when inbound lane is silent', async () => {
  const inboundLane = {
    blocksOutbound: () => false,
    msSinceSpeechSilent: () => 500
  }
  const result = await waitForOutboundAllowed({
    inboundLane,
    sceneClassifier: null,
    quietMs: 100,
    maxWaitMs: 2000,
    pollMs: 20
  })
  assert.equal(result.allowed, true)
  assert.equal(result.reason, 'inbound_quiet')
})

test('ivr delivery controller defers flush until join + quiet', async () => {
  const flushed = []
  let botMsgs = [{ messageText: 'a' }]
  let lastFinalAt = Date.now() - 50
  const inboundLane = {
    msSinceSpeechSilent: () => 500,
    blocksOutbound: () => false
  }
  const ctrl = createIvrDeliveryController({
    getBotMsgs: () => botMsgs,
    getLastSttFinalAt: () => lastFinalAt,
    realFlush: () => {
      flushed.push(botMsgs.length)
      botMsgs = []
    },
    inboundLane,
    sceneClassifier: { getScene: () => 'speech', isMusicDominant: () => false },
    caps: {
      [Capabilities.VOIP_IVR_DEFER_DELIVERY_ENABLE]: true,
      [Capabilities.VOIP_IVR_DELIVERY_QUIET_MS]: 50,
      [Capabilities.VOIP_IVR_JOIN_TIMEOUT_MS]: 80,
      [Capabilities.VOIP_IVR_DELIVERY_MAX_WAIT_MS]: 3000
    },
    Capabilities,
    sessionId: 's1',
    _info: () => {}
  })
  ctrl.requestDelivery()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(flushed.length, 1)
})

test('ivr delivery waits longer when a new stt final arrives during join window', async () => {
  const flushed = []
  let botMsgs = [{ messageText: 'a' }]
  let lastFinalAt = Date.now() - 20
  const inboundLane = {
    msSinceSpeechSilent: () => 500,
    blocksOutbound: () => false
  }
  const ctrl = createIvrDeliveryController({
    getBotMsgs: () => botMsgs,
    getLastSttFinalAt: () => lastFinalAt,
    realFlush: () => {
      flushed.push(botMsgs.length)
      botMsgs = []
    },
    inboundLane,
    sceneClassifier: { getScene: () => 'speech', isMusicDominant: () => false },
    caps: {
      [Capabilities.VOIP_IVR_DEFER_DELIVERY_ENABLE]: true,
      [Capabilities.VOIP_IVR_DELIVERY_QUIET_MS]: 50,
      [Capabilities.VOIP_IVR_JOIN_TIMEOUT_MS]: 200,
      [Capabilities.VOIP_IVR_DELIVERY_MAX_WAIT_MS]: 3000
    },
    Capabilities,
    sessionId: 's2',
    _info: () => {}
  })
  ctrl.requestDelivery()
  setTimeout(() => {
    lastFinalAt = Date.now()
    botMsgs = [{ messageText: 'a' }, { messageText: 'b' }]
  }, 80)
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0], 2)
})

test('ivr delivery skips immediately when buffer already empty', async () => {
  const flushed = []
  const logs = []
  const ctrl = createIvrDeliveryController({
    getBotMsgs: () => [],
    getLastSttFinalAt: () => Date.now(),
    realFlush: () => flushed.push(1),
    inboundLane: { msSinceSpeechSilent: () => 500, blocksOutbound: () => false },
    sceneClassifier: { getScene: () => 'unknown', isMusicDominant: () => false },
    caps: {
      [Capabilities.VOIP_IVR_DEFER_DELIVERY_ENABLE]: true,
      [Capabilities.VOIP_IVR_DELIVERY_QUIET_MS]: 50,
      [Capabilities.VOIP_IVR_JOIN_TIMEOUT_MS]: 200,
      [Capabilities.VOIP_IVR_DELIVERY_MAX_WAIT_MS]: 3000
    },
    Capabilities,
    sessionId: 's-empty',
    _info: (event, data) => logs.push({ event, ...data })
  })
  ctrl.requestDelivery()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(flushed.length, 0)
  assert.ok(logs.some(l => l.event === 'ivr_turn_delivery_skipped'))
})
