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
| `openai/whisper-large-v3-turbo` (via OpenRouter, `STT_MODEL=whisper`) | no | yes | untested | Clean French and English. Derja is close but not exact. Code-switch comes out in Arabic script (`رانديفول`, `رندزفو`, `درماتولوج`). Fast: about 1 to 3 s per clip. | Per-provider on OpenRouter: DeepInfra $0.00000333, Groq $0.0000111 (unit not stated) |
| `gemini-3.5-transcribe` (Google API, `GEMINI_PROVIDER=google`) | no | yes (some Arabic-script French words, e.g. `راندي فو`, `ديرماتولوجي`) | untested | Clean French and English. Code-switch is mixed: `الـ rendez-vous` kept in Latin script, but `dermatologue` and `Dr Ben Salah` came out in Arabic script. Free tier allows only 3 requests per minute. | Not checked |
| `google/gemini-3.5-transcribe` (via OpenRouter, `/audio/transcriptions`) | no | no | untested | Same 7 clips as the Google API run. Kept `rendez-vous` and `dermatologue` in Latin script; Derja is close. About 3 s per clip. No free-tier rate limit hit. | $2.00 in / $12.00 out (per token, audio) |
| `google/gemini-3.1-flash-lite` (via OpenRouter, chat with audio, `reasoning: none`) | no | no | pretty good (transcription) | Fast, about 0.8 s. Not fast enough for a smooth conversation: no streaming. Used for both the LiveKit STT and the phone caller transcript. | $0.25 in / $1.50 out |
| `google/gemini-3-flash-preview` (via OpenRouter, chat with audio, `GEMINI_STT_MODEL`, LiveKit agent) | no | no | good | Slow (around 1.5 s). Clean French, Derja in Arabic script, French words in Latin script on the clips. Once wrote a dialogue instead of a transcript on a long call chunk; the prompt and output cap were tightened afterwards, not yet re-tested on a call. | $0.50 in / $3.00 out |
| `google/gemini-3.5-flash-lite` (via OpenRouter, chat with audio, `reasoning: minimal`) | no | no | bad | Speed: slow (around 1.5 s). Mostly writes Derja in Latin letters (`ma'neha nheb docteur qalb`). Drops parts of longer sentences (medical-term clip came back as `1 rendez-vous dermatologue`). Cannot turn reasoning off, so it uses `minimal`. | $0.30 in / $2.50 out |
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
| `gemini-3.8-flash-lite-tts`, voice `Charon` (Google API, `TTS_PROVIDER=google`) | untested (measured: first audio ~0.6-1.2 s, full reply ~2-2.5 s) | untested (same model as the OpenRouter row) | untested | Streams audio chunks as they are generated, so it should feel much faster than via OpenRouter. Uses `GEMINI_API_KEY`. | $0.50 in / $6.00 out (third-party figures, not confirmed) |
| `google/gemini-3.8-flash-lite-tts`, voice `Charon` (via OpenRouter) | slow (~2 s) | very good (almost perfect Tunisian dialect) | ok | Not as slow as flash-tts, but not very smooth in a conversation. | $0.50 in / $6.00 out |
| `google/gemini-3.8-flash-tts`, voice `Charon` (via OpenRouter) | very slow (~4-5 s) | best (almost perfect Tunisian dialect) | bad | Too slow to be used in a conversation, despite the best voice quality tried. | $0.50 in / $9.00 out |
| `microsoft/mai-voice-2.1-flash`, voice `fr-FR-Harper` (via OpenRouter) | fast (~0.5 s) | bad (Arabic pronunciation not good, no Tunisian accent) | bad | No Arabic voice in its 97 voices. Low-latency model. | $15 per million input characters |
| `gemini-3.1-flash-tts-preview`, voice `Charon` (Google API, `TTS_PROVIDER=gemini`, `GEMINI_PROVIDER=google`) | slow (~2 s) | ok | untested | Current TTS on the Google path. Same model as the OpenRouter row below, which was rated very slow and not Tunisian. | Not checked |
| `google/gemini-3.1-flash-tts-preview`, voice `Charon` (via OpenRouter) | very slow (~5 s) | bad (accent is not Tunisian) | untested | Preview model, Google's step up from 2.5 Flash TTS. | $1.00 in / $20.00 out |
| `elevenlabs/eleven-v4`, voice `sarah` (via OpenRouter) | ok (~1.5 s) | ok (accent not that bad) | bad | Very expensive. Lists 90+ languages. | $0.00004 per unit, likely per character (~$40 per million characters) |
| `gpt-4o-mini-tts`, voice `coral` (OpenAI API, `TTS_PROVIDER=openai`) | slow (~3 s, whole reply, not streamed) | untested | untested | Not on OpenRouter, so it uses `OPENAI_API_KEY`. Accepts style instructions (`OPENAI_TTS_INSTRUCTIONS`) for accent. None set yet. | Not checked |
| No Arabic support: `hexgrad/kokoro-82m` (voice `af_heart`, via OpenRouter); `fish-audio/s2.1-pro-free:free` (via OpenRouter); Deepgram Aura-2 | untested | n/a (no Arabic) | bad | Not an option: none supports Arabic. Kokoro's listed languages: English, Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese. Aura-2 supports French but has no Arabic voices. Fish has no Arabic and no voice list on OpenRouter. | Kokoro $0.62 in; Fish free (testing only); Aura-2 not checked |

## Realtime models (speech-to-speech, phone path) — `BACKEND`

These run on their own providers, so their prices aren't in OpenRouter's list and I haven't checked them. Speed here means how soon a reply starts: fast means it answers right away, with no thinking delay.

| Model | Verdict | Notes |
|---|---|---|
| `gemini-3.8-live` (`GEMINI_MODEL`, `BACKEND=gemini`) | untested | Tunisian dialect: good. Speed: fast. Understanding: not good (doesn't understand well). |
| `gemini-3.8-live-extended-thinking` (`GEMINI_MODEL`, `BACKEND=gemini`) | untested | Accent: decent. Speed: fast. Understanding: not good (doesn't understand well). |
| `gemini-3.1-flash-live-preview` (`GEMINI_MODEL`) | untested | Tunisian dialect: almost perfect. Speed: very fast. Interruptions: very good. Thinking: the best of the models tried, even compared with the extended-thinking model. Understanding: well. Transcript accuracy: very bad, even though the model understands the caller. The transcript comes from a separate speech-to-text step inside the Live API, not from the model's understanding, and our code sends it no options (no language or vocabulary hints), so it can't be tuned. |
| GPT-Live (`BACKEND=gpt-live`, `gpt-live-1`) | bad | Speed: fast. Too artificial. Accent: decent (not perfect). Interruptions: handles them well. Understanding: alright, but makes mistakes. Flow: not very smooth. Costly (two models). |
| OpenAI Realtime (`BACKEND=openai`) | good | Uses `OPENAI_MODEL`. Speed: fast. Speech recognition: good. Voice: not perfect with the right accent. Smartest model so far. Very good at handling interruptions. Cost: very expensive. |
| `gpt-realtime-2.1` (`OPENAI_MODEL`, `BACKEND=openai`) | untested | Speed: fast. Pronunciation: good. Understanding Arabic: not that well. Flow: not that well. |

## Other

| Model | Role | Notes | Price (in / out) |
|---|---|---|---|
| `openai/gpt-5.4-nano` | Background name and language capture (`PROFILE_EXTRACT_MODEL`) | Runs on every caller sentence. | $0.20 / $1.25 |
