# botium-connector-voip

## Bot turn flush (Namo + TEN VAD)

VoIP calls buffer Azure (or other) STT finals, then **Namo** scores joined text for semantic end-of-utterance. **TEN VAD** on the inbound audio leg provides soft-end / **reopen** so digit-group pauses stay one turn while separate menu prompts can still split after commit.

| Piece | Role |
|-------|------|
| Namo (`videosdk-live/Namo-Turn-Detector-v1-English`) | ONNX + tokenizer; auto-download on first call |
| TEN VAD (`ten-vad.int8.onnx`) | Bundled under `assets/models/`; continuous `InboundLane` |
| PSST timer | **Fallback only** when Namo fails to load (`VOIP_NAMO_FALLBACK_HANDLING`, default `PSST`) |

Only **committed** turns call `queueBotSays`. See [TURN-DETECTION.md](./TURN-DETECTION.md).

### Models

- Namo: `~/.cache/botium/namo` or `BOTIUM_NAMO_CACHE_DIR`; override with `VOIP_NAMO_MODEL_PATH`.
- TEN VAD: bundled asset or `VOIP_TEN_VAD_MODEL_PATH` / `BOTIUM_TEN_VAD_MODEL_PATH`.

Prefetch locally:

```bash
node scripts/prefetch-namo-model.cjs
```

### Key capabilities

- `VOIP_NAMO_EOU_THRESHOLD` (default `0.85`)
- `VOIP_NAMO_REOPEN_MS` (default `800`)
- `VOIP_NAMO_MAX_WAIT_MS`, `VOIP_NAMO_EMIT_STABLE_MS`, `VOIP_NAMO_DTMF_ECHO_MS`
- `VOIP_STT_MESSAGE_HANDLING` — use `NAMO` (recommended), `PSST`, or `JOIN` to buffer finals; see [TURN-DETECTION.md](./TURN-DETECTION.md) (not `ORIGINAL` for coach/OTS flows)
- `VOIP_OTS_LATENCY_PROFILE` — objective-test latency presets (see `applyOtsLatencyProfile` in `src/reply-budget.js`)

### Reply budget (OTS)

When `VOIP_REPLY_BUDGET_MS` is set, connector commit respects `computeConnectorDeadlineMs` via Namo `max_wait` and budget-aware flush.
