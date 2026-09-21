const _ = require('lodash')

const pcm16ToFloat32 = (pcm, channels = 1) => {
  if (!pcm || pcm.length < 2) return new Float32Array(0)
  const frameBytes = 2 * channels
  const out = new Float32Array(Math.floor(pcm.length / frameBytes))
  for (let i = 0, j = 0; i + 1 < pcm.length; i += frameBytes, j++) {
    out[j] = pcm.readInt16LE(i) / 32768
  }
  return out
}

const slicePcmFromStream = (audioStream, startSec, endSec) => {
  const stream = audioStream
  if (!stream || !stream.format || !stream.pcmParts || !stream.pcmParts.length) return null
  if (!_.isFinite(startSec) || !_.isFinite(endSec) || endSec <= startSec) return null

  const { sampleRate, channels, bitsPerSample } = stream.format
  if (bitsPerSample !== 16) return null
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8)
  const frameBytes = channels * (bitsPerSample / 8)
  const startByte = Math.floor(startSec * bytesPerSec / frameBytes) * frameBytes
  const endByte = Math.ceil(endSec * bytesPerSec / frameBytes) * frameBytes
  if (startByte >= stream.totalBytes) return null
  const clampedEnd = Math.min(endByte, stream.totalBytes)
  const sliceLen = clampedEnd - startByte
  if (sliceLen <= 0) return null

  const pcm = Buffer.allocUnsafe(sliceLen)
  let written = 0
  let offset = 0
  for (const part of stream.pcmParts) {
    const partEnd = offset + part.length
    if (partEnd <= startByte) {
      offset += part.length
      continue
    }
    if (offset >= clampedEnd) break
    const copyFrom = Math.max(0, startByte - offset)
    const copyTo = Math.min(part.length, clampedEnd - offset)
    part.copy(pcm, written, copyFrom, copyTo)
    written += copyTo - copyFrom
    offset += part.length
  }
  if (written === 0) return null
  const sliced = written < sliceLen ? pcm.slice(0, written) : pcm
  return { pcm: sliced, sampleRate, channels }
}

const getTurnAudioFloat32 = (audioStream, botMsgs, endSec) => {
  const startSec = _.get(botMsgs, '[0].sourceData.data.start', null)
  const lastEnd = _.get(botMsgs, `[${botMsgs.length - 1}].sourceData.data.end`, endSec)
  const sliceEnd = _.isFinite(endSec) ? endSec : lastEnd
  if (!_.isFinite(startSec) || !_.isFinite(sliceEnd) || sliceEnd <= startSec) return null
  const sliced = slicePcmFromStream(audioStream, startSec, sliceEnd)
  if (!sliced) return null
  const mono = sliced.channels === 1
    ? pcm16ToFloat32(sliced.pcm, 1)
    : pcm16ToFloat32(sliced.pcm, sliced.channels)
  return { samples: mono, sampleRate: sliced.sampleRate }
}

const recordingSecNow = (audioStream) => {
  const fmt = audioStream && audioStream.format
  const bytesPerSec = fmt ? fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8) : null
  if (!bytesPerSec || !audioStream || !(audioStream.totalBytes > 0)) return null
  return audioStream.totalBytes / bytesPerSec
}

module.exports = {
  pcm16ToFloat32,
  slicePcmFromStream,
  getTurnAudioFloat32,
  recordingSecNow
}
