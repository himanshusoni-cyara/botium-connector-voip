const { PsstTurnHandler } = require('./psst-turn-handler')
const { SmartTurnHandler } = require('./smart-turn-handler')

const TURN_HANDLERS = {
  PSST: PsstTurnHandler,
  SMART_TURN: SmartTurnHandler
}

const createTurnHandler = (caps, Capabilities, ctx) => {
  const raw = caps && caps[Capabilities.VOIP_STT_TURN_HANDLER]
  const key = String(raw || 'PSST').toUpperCase()
  const Handler = TURN_HANDLERS[key] || PsstTurnHandler
  return new Handler(ctx)
}

module.exports = { createTurnHandler, TURN_HANDLERS }
