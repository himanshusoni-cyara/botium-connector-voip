# botium-connector-voip

## Bot turn flush handlers (`VOIP_STT_TURN_HANDLER`)

| Value | Description |
|-------|-------------|
| `PSST` (default) | Legacy silence-timer flush (JOIN/PSST/CONCAT buffering). |
| `SMART_TURN` | RMS VAD pause + Smart Turn v3.2 (`@micdrop/smart-turn`) on buffered bot audio, with a max-silence safety cap. Falls back to PSST timer if inference is unavailable. |

### Smart Turn setup

1. Set `VOIP_STT_TURN_HANDLER=SMART_TURN` on the VoIP chatbot.
2. On first validate/call, the connector **auto-downloads** [`smart-turn-v3.2-cpu.onnx`](https://huggingface.co/pipecat-ai/smart-turn-v3) (~8 MB) into `~/.cache/botium/smart-turn-v3.2-cpu/` (override with `BOTIUM_SMART_TURN_CACHE_DIR`).
3. Optional: set `VOIP_SMART_TURN_MODEL_PATH` or `BOTIUM_SMART_TURN_MODEL_PATH` to use a local ONNX file instead of the cache.

Optional tuning: `VOIP_SMART_TURN_THRESHOLD`, `VOIP_SMART_TURN_MAX_SILENCE_MS`, `VOIP_SMART_TURN_VAD_MIN_SILENCE_MS`, `VOIP_SMART_TURN_INFERENCE_TIMEOUT_MS`, `VOIP_SMART_TURN_MIN_COMMIT_DELAY_MS`.

Install optional native deps when using Smart Turn:

```bash
npm install @micdrop/smart-turn onnxruntime-node
```
