const fs = require('fs')
const path = require('path')

/**
 * Resolve assets/models for vendored ONNX. Rollup bundles to dist/ where __dirname is
 * .../dist (use ../assets/models). Unit tests load this file from src/ (../../assets/models).
 * Avoid require.resolve — Rollup emits commonjsRequire without .resolve.
 */
const assetsModelsDir = () => {
  const candidates = [
    path.join(__dirname, '../assets/models'),
    path.join(__dirname, '../../assets/models')
  ]
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return candidates[0]
}

const packageRoot = () => path.join(assetsModelsDir(), '..', '..')

const bundledModelPath = (filename) => path.join(assetsModelsDir(), filename)

module.exports = {
  packageRoot,
  bundledModelPath,
  assetsModelsDir
}
