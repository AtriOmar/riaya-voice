# Model notes

Every model we try for the LiveKit agent, with the verdict from testing. Update the verdict column when the user rates a model.

Verdicts: **good**, **ok**, **bad**, or **untested**. Notes give the reason in short.

Prices are from OpenRouter's model list, checked 2026-10-11. LLM and speech output prices are per million tokens. "Not checked" means the model runs on another provider and I couldn't read its price here.

## STT (speech-to-text) — `STT_MODEL`

| Model | Streaming | Transliterates | Verdict | Notes | Price |
|---|---|---|---|---|---|
| `assemblyai/universal-3-5-pro` | yes | no | bad | User: not accurate in Arabic, but does not transliterate non-Arabic words. | Not checked (LiveKit Inference) |
| `gpt-realtime-whisper` | yes | yes | untested | Realtime-only; uses LiveKit VAD, so the end-of-call "WritableStream is locked" error appears. With Arabic locked, French words came out in Arabic script (`أديرماتولوجي`). | Not checked (OpenAI). An earlier third-party page said $0.017/min, unverified. |
| `gpt-transcribe` | yes | yes | ok | Matches `gpt-live-transcribe` on the 7 test clips. Supports language lists and keywords. | Not checked (OpenAI) |
| `gpt-live-transcribe` | yes | yes | bad | User said "the STT model is shit". Light code-switch comes out in Arabic script. | Not checked (OpenAI) |
| `gpt-4o-transcribe` | yes | untested | bad | Arabic is not bad, but it often mistakes Arabic for other languages. Partial text may wait for end of speech. | Not checked (OpenAI) |
| `mai` (MAI Transcribe 2, via OpenRouter) | no | yes | bad | Batch. Turns French words into Arabic script. | Not in OpenRouter's model list |
| `gemini` (`google/gemini-3.8-flash`, via OpenRouter) | no | no | ok | Best on code-switching in the 7-clip test (kept French in Latin script). Waits for each sentence. | $0.75 in (audio also $0.75), $3.75 out |
| `deepgram/nova-3` | yes | yes | bad | With an Arabic hint, French and English come back empty. In auto mode, Derja comes back empty. Transliterates `rendez-vous` in the Arabic-hint test. | Not in OpenRouter's model list |

## LLM (conversation) — `OPENROUTER_MODEL`

Quality is intelligence in conversation, using a main word — **bad, medium, ok, good, very good, best** — with any detail in parentheses. Speed is rated **fast / ok / slow** (or **very slow**).

| Model | Speed | Quality | Verdict | Notes | Price (in / out) |
|---|---|---|---|---|---|
| `google/gemini-2.5-flash` | ok (speed is all right) | good (follows context well) | untested | Set again after the lite model. | $0.30 / $2.50 |
| `google/gemini-2.5-flash-lite` | untested | bad | bad | User said it was "so stupid". | $0.10 / $0.40 |
| `google/gemini-3.1-flash-lite` | untested | untested | untested | Set briefly, then replaced for "good, not very slow". | $0.25 / $1.50 |
| `google/gemini-3.8-flash` | slow | untested | bad | User said it was "taking too long". | $0.75 / $3.75 |
| `openai/gpt-5.4-mini` | untested | untested | untested | Original LLM before the Gemini switch. | $0.75 / $4.50 |
| `anthropic/claude-haiku-5.5` | untested | untested | untested | Newest Haiku. Considered, not set. | $0.10 / $0.50 |
| `openai/gpt-4.1-mini` | untested | untested | untested | Considered, not set. | $0.40 / $1.60 |

## TTS (text-to-speech) — `TTS_PROVIDER`

Speed is rated **fast / ok / slow** (or **very slow**). Quality uses a main word — **bad, medium, ok, good, very good, best** — with any detail in parentheses.

| Model | Speed | Quality | Verdict | Notes | Price |
|---|---|---|---|---|---|
| `xai/tts-1` (LiveKit Inference) | very fast (~0.25 s) | medium (pronounces Arabic, not a Tunisian accent) | untested | Via `TTS_PROVIDER=inference`. | $15 per million characters |
| Inworld `inworld-tts-2`, voice `Omar` | fast (alright) | medium (no Tunisian accent) | maybe | `TTS_PROVIDER=inworld`. Used before the switch. | Not checked (Inworld) |
| `google/gemini-3.8-flash-lite-tts`, voice `Charon` (via OpenRouter) | slow (~2 s) | very good (almost perfect Tunisian dialect) | ok | Not as slow as flash-tts, but not very smooth in a conversation. | $0.50 in / $6.00 out |
| `google/gemini-3.8-flash-tts`, voice `Charon` (via OpenRouter) | very slow (~4-5 s) | best (almost perfect Tunisian dialect) | bad | Too slow to be used in a conversation, despite the best voice quality tried. | $0.50 in / $9.00 out |
| `microsoft/mai-voice-2.1-flash`, voice `fr-FR-Harper` (via OpenRouter) | fast (~0.5 s) | bad (Arabic pronunciation not good, no Tunisian accent) | bad | No Arabic voice in its 97 voices. Low-latency model. | $15 per million input characters |
| `google/gemini-3.1-flash-tts-preview`, voice `Charon` (via OpenRouter) | very slow (~5 s) | bad (accent is not Tunisian) | untested | Preview model, Google's step up from 2.5 Flash TTS. | $1.00 in / $20.00 out |
| `elevenlabs/eleven-v4`, voice `sarah` (via OpenRouter) | ok (~1.5 s) | ok (accent not that bad) | bad | Very expensive. Lists 90+ languages. | $0.00004 per unit, likely per character (~$40 per million characters) |
| No Arabic support: `hexgrad/kokoro-82m` (voice `af_heart`, via OpenRouter); `fish-audio/s2.1-pro-free:free` (via OpenRouter); Deepgram Aura-2 | untested | n/a (no Arabic) | bad | Not an option: none supports Arabic. Kokoro's listed languages: English, Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese. Aura-2 supports French but has no Arabic voices. Fish has no Arabic and no voice list on OpenRouter. | Kokoro $0.62 in; Fish free (testing only); Aura-2 not checked |

## Realtime models (speech-to-speech, phone path) — `BACKEND`

These run on their own providers, so their prices aren't in OpenRouter's list and I haven't checked them.

| Model | Verdict | Notes |
|---|---|---|
| Gemini Live (`BACKEND=gemini`) | untested | Native turn handling. Not yet compared with the LiveKit agent. |
| GPT-Live (`BACKEND=gpt-live`) | bad | User said it "consumes too much" (two models, costly). |
| Inworld realtime (`BACKEND=inworld`) | untested | Hosted STT + LLM + TTS. |
| OpenAI Realtime (`BACKEND=openai`) | good | Uses `OPENAI_MODEL`. Speech recognition: good. Voice: not perfect with the right accent. Smartest model so far. Very good at handling interruptions. Cost: very expensive. |

## Other

| Model | Role | Notes | Price (in / out) |
|---|---|---|---|
| `openai/gpt-5.4-nano` | Background name and language capture (`PROFILE_EXTRACT_MODEL`) | Runs on every caller sentence. | $0.20 / $1.25 |
