const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  HANDLING_NAMO,
  isNamoHandling,
  isBufferedSttHandling
} = require('../src/stt-message-handling')

test('isNamoHandling recognizes NAMO case-insensitively', () => {
  assert.equal(HANDLING_NAMO, 'NAMO')
  assert.equal(isNamoHandling('NAMO'), true)
  assert.equal(isNamoHandling('namo'), true)
  assert.equal(isNamoHandling('PSST'), false)
})

test('isBufferedSttHandling includes NAMO and legacy join modes', () => {
  assert.equal(isBufferedSttHandling('NAMO'), true)
  assert.equal(isBufferedSttHandling('PSST'), true)
  assert.equal(isBufferedSttHandling('JOIN'), true)
  assert.equal(isBufferedSttHandling('CONCAT'), true)
  assert.equal(isBufferedSttHandling('ORIGINAL'), false)
  assert.equal(isBufferedSttHandling('SPLIT'), false)
})
