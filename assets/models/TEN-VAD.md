# TEN VAD model (`ten-vad.int8.onnx`)

This file is vendored in the connector for Smart Turn pause detection (no runtime download required).

## Source (download)

- **Packaged ONNX (what we ship):**  
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.int8.onnx  
- **Release tag:** https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models  
- **Implementation reference:** sherpa-onnx `TenVadModel`  
  https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/ten-vad-model.cc  

Sherpa repackages the original TEN VAD ONNX and adds ONNX metadata (`model_type`, `mean`, `inv_stddev`, `window`) required for inference. Raw exports from the TEN framework without that metadata are not compatible with this connector.

## Upstream model

- **TEN VAD (TEN Framework):** https://github.com/TEN-framework/ten-vad  

## License

Follow the license terms of **sherpa-onnx** and the **TEN VAD** upstream when redistributing this file. Botium connector code is MIT; third-party model weights are not.

## Updating

Replace `ten-vad.int8.onnx` only from the official sherpa-onnx `asr-models` release URL above, re-run connector tests (`parseTenVadMetadata` / TEN VAD smoke), and note the release URL in the commit message.
