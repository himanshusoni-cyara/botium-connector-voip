const DEFAULT_RMS_THRESHOLD = 450

class RmsVad {
  constructor ({ minSilenceMs = 280, frameMs = 30, rmsThreshold = DEFAULT_RMS_THRESHOLD } = {}) {
    this.minSilenceMs = minSilenceMs
    this.frameMs = frameMs
    this.rmsThreshold = rmsThreshold
    this._speechActive = false
    this._silenceMs = 0
    this._onPause = null
  }

  onPause (fn) {
    this._onPause = fn
  }

  reset () {
    this._speechActive = false
    this._silenceMs = 0
  }

  feedPcm16 (pcm, sampleRate, channels = 1) {
    if (!pcm || pcm.length < 2 || !sampleRate) return
    const frameBytes = 2 * channels
    const samplesPerFrame = Math.max(1, Math.floor((sampleRate * this.frameMs) / 1000))
    const bytesPerFrame = samplesPerFrame * frameBytes
    for (let offset = 0; offset + frameBytes <= pcm.length; offset += bytesPerFrame) {
      let sum = 0
      let count = 0
      const end = Math.min(offset + bytesPerFrame, pcm.length - 1)
      for (let i = offset; i + 1 <= end; i += frameBytes) {
        const sample = pcm.readInt16LE(i)
        sum += sample * sample
        count += 1
      }
      const rms = count > 0 ? Math.sqrt(sum / count) : 0
      const isSpeech = rms >= this.rmsThreshold
      if (isSpeech) {
        this._speechActive = true
        this._silenceMs = 0
      } else if (this._speechActive) {
        this._silenceMs += this.frameMs
        if (this._silenceMs >= this.minSilenceMs) {
          this._speechActive = false
          this._silenceMs = 0
          if (this._onPause) this._onPause()
        }
      }
    }
  }
}

module.exports = { RmsVad, DEFAULT_RMS_THRESHOLD }
