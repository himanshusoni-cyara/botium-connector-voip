# CED-Tiny model (`ced-tiny.int8.onnx`)

Bundled for inbound music vs speech scene classification (hold music / MOH intelligence).

## Source

- **ONNX bundle:** https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19  
- **Upstream:** [RicherMans/CED](https://github.com/RicherMans/CED) (AudioSet tagging, ~5.5M params)

## Files

| File | Role |
|------|------|
| `ced-tiny.int8.onnx` | int8 ONNX (~6 MB) |
| `class_labels_indices.csv` | AudioSet label indices (Speech, Music, …) |

## Updating

Replace both files from the Hugging Face repo above and note the release in the commit message.

## License

Follow CED / sherpa-onnx / AudioSet redistribution terms when shipping this file.
