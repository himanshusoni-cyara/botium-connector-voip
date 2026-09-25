const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wait until inbound speech (and optional STT partials) allow agent playout.
 */
async function waitForOutboundAllowed ({
  inboundLane,
  sceneClassifier,
  quietMs,
  maxWaitMs,
  pollMs = 50,
  hasRecentSttPartial = () => false
}) {
  const quiet = Math.max(0, Number(quietMs) || 430)
  const cap = Math.max(quiet, Number(maxWaitMs) || 5000)
  const start = Date.now()
  while (Date.now() - start < cap) {
    const musicDominant = sceneClassifier && sceneClassifier.isMusicDominant
      ? sceneClassifier.isMusicDominant()
      : false
    const blocked = inboundLane && inboundLane.blocksOutbound({
      musicDominant,
      hasSttPartials: hasRecentSttPartial()
    })
    if (!blocked && inboundLane && inboundLane.msSinceSpeechSilent() >= quiet) {
      return { waitedMs: Date.now() - start, allowed: true, reason: 'inbound_quiet' }
    }
    if (!inboundLane) {
      return { waitedMs: 0, allowed: true, reason: 'no_lane' }
    }
    await sleep(pollMs)
  }
  return { waitedMs: Date.now() - start, allowed: true, reason: 'max_wait' }
}

module.exports = { waitForOutboundAllowed }
