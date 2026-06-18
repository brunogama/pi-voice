# Pi Voice

A Pi package that adds `/voice`: hold-Space microphone dictation for Pi. It records audio with `ffmpeg`, transcribes with local `whisper-cli` by default, and inserts the transcript into the prompt editor for review.


## Project documentation

- [Installation](docs/INSTALLATION.md)
- [Usage](docs/USAGE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Privacy](docs/PRIVACY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Publishing](docs/PUBLISHING.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Install

From a local checkout:

```sh
pi install /Users/bruno/Developer/pi-voice
```

From GitHub after publishing/tagging:

```sh
pi install git:github.com/brunogama/pi-voice@v0.1.0
```

From npm after publishing:

```sh
pi install npm:@brunogama/pi-voice
```

Restart Pi or run `/reload`, then:

```text
/voice doctor
/voice
```

---

# Pi `/voice` Extension

Global Pi extension for recording microphone audio in interactive Pi TUI sessions, transcribing it, and inserting the transcript into the active prompt editor for review.

## Usage

- `/voice` or `/voice toggle` — toggle persistent hold-Space voice mode; enabling it clears the prompt.
- Hold `Space` — start recording; keep holding to continue recording.
- Release `Space` — after a short key-repeat pause, stop, transcribe, and insert the transcript. Voice mode stays enabled for the next dictation.
- `/voice start` — start recording immediately without hold-Space mode.
- `/voice stop` — stop the active recording, transcribe it, and insert the transcript.
- `/voice off` — exit hold-Space voice mode and discard active audio if needed.
- `/voice cancel` — discard an active recording or abort an active transcription. No transcript is inserted; voice mode remains ready unless you type `/voice` or `/voice off`.
- `/voice status` — show whether voice is idle, recording, or transcribing.
- `/voice doctor` — check `ffmpeg` and the selected transcription backend.
- `/voice devices` — on macOS, list `ffmpeg`/`avfoundation` audio devices.
- `/voice help` — show command and privacy help inside Pi.

Recording starts only while Pi is idle in interactive TUI mode. `/voice` clears the current editor text before entering hold-Space mode. Voice mode stays enabled after each release/transcription and is disabled only when you type `/voice` again (or `/voice off`). While voice mode is active, Pi shows an animated spectrum widget below the editor; during recording it is driven by ffmpeg RMS audio levels when available. Because terminals do not expose true key-up events, release is detected by the pause in repeated Space keypresses; tune this with `PI_VOICE_SPACE_RELEASE_MS` if needed. The transcript is inserted into the prompt editor only. The extension never calls `sendUserMessage` and never submits the prompt for you.

## Privacy model

The default backend is local-only:

```sh
export PI_VOICE_BACKEND=whisper-cli
```

Cloud transcription is used only when you explicitly opt in:

```sh
export PI_VOICE_BACKEND=openai-compatible
```

Having `OPENAI_API_KEY` in your environment is not enough to select cloud transcription. If the local backend is selected, `/voice doctor` reports that `OPENAI_API_KEY` is ignored.

When cloud transcription is explicitly enabled, stopping a recording uploads the temporary WAV to `PI_VOICE_ENDPOINT` and the UI/doctor output shows the endpoint host. Endpoint safety rules reject URL credentials, reject non-HTTPS remote endpoints, and allow plain HTTP only for exact loopback hosts (`localhost`, `127.0.0.1`, `::1`). API keys and Authorization headers are never displayed.

Temporary `pi-voice-*` WAV directories are deleted on successful stop, cancel, transcription error, max-duration timeout, reload/shutdown, and agent start. Timeout/agent-start cleanup discards audio only; it does not transcribe or upload in the background.

## Setup

Runtime dependencies are user-managed. This extension does not install packages, download models, or mutate other extensions.

### Capture dependency

Install `ffmpeg` yourself if needed:

```sh
brew install ffmpeg
```

Common capture variables:

```sh
export PI_VOICE_FFMPEG=ffmpeg
export PI_VOICE_FFMPEG_FORMAT=avfoundation   # macOS default
export PI_VOICE_FFMPEG_INPUT=:0              # macOS default audio device index
export PI_VOICE_MAX_SECONDS=120
export PI_VOICE_SPACE_RELEASE_MS=850  # hold-Space release detection grace
```

Run `/voice devices` on macOS to inspect `avfoundation` device indexes, then set `PI_VOICE_FFMPEG_INPUT` as needed.

### Local `whisper-cli` backend

Install whisper.cpp yourself and provide a model file:

```sh
brew install whisper-cpp
mkdir -p ~/.pi/models
# Put a ggml model at ~/.pi/models/ggml-base.en.bin, or set PI_VOICE_WHISPER_MODEL.
export PI_VOICE_BACKEND=whisper-cli
export PI_VOICE_WHISPER_BIN=whisper-cli
export PI_VOICE_WHISPER_MODEL=~/.pi/models/ggml-base.en.bin
```

The extension checks `whisper-cli --help` at runtime and requires compatible text-output and output-prefix flags (`--output-txt`/`-otxt`, `--output-file`/`-of`). It uses `--no-timestamps`/`-nt` when available, otherwise it strips common timestamp prefixes after transcription and warns in `/voice doctor`.

### OpenAI-compatible backend

Explicitly opt in to cloud transcription and provide a key for non-loopback endpoints:

```sh
export PI_VOICE_BACKEND=openai-compatible
export OPENAI_API_KEY=...
export PI_VOICE_ENDPOINT=https://api.openai.com/v1/audio/transcriptions
export PI_VOICE_MODEL=whisper-1
```

Optional:

```sh
export PI_VOICE_LANGUAGE=en
export PI_VOICE_TIMEOUT_MS=120000
```

Loopback HTTP endpoints are allowed for local OpenAI-compatible servers:

```sh
export PI_VOICE_BACKEND=openai-compatible
export PI_VOICE_ENDPOINT=http://localhost:10301/v1/audio/transcriptions
```

## Editor insertion

Default mode uses Pi's paste handling:

```sh
export PI_VOICE_INSERT_MODE=paste
```

Append mode reads and writes the editor text:

```sh
export PI_VOICE_INSERT_MODE=append
```

Trailing space is enabled by default so you can keep typing naturally:

```sh
export PI_VOICE_TRAILING_SPACE=1
```

Set `PI_VOICE_TRAILING_SPACE=0` to disable it.

## Troubleshooting

- **`ffmpeg` missing**: install/configure `ffmpeg`, or set `PI_VOICE_FFMPEG` to its path. Run `/voice doctor`.
- **macOS microphone permission**: grant Terminal/iTerm/Ghostty microphone access in System Settings, then retry.
- **wrong input device**: run `/voice devices` on macOS and set `PI_VOICE_FFMPEG_INPUT` (for example, `:0`, `:1`).
- **recording too small**: speak before stopping, verify mic permission/device selection, and check `PI_VOICE_MIN_BYTES`.
- **missing local model**: set `PI_VOICE_WHISPER_MODEL` to an existing whisper.cpp GGML model file.
- **unsupported `whisper-cli` flags**: update whisper.cpp or set `PI_VOICE_WHISPER_BIN` to a compatible binary.
- **endpoint rejected**: use HTTPS for remote endpoints; use HTTP only for exact loopback hosts; do not put credentials in the URL.
- **cloud key missing**: set `PI_VOICE_API_KEY` or `OPENAI_API_KEY` when using a non-loopback OpenAI-compatible endpoint.

Run `/voice doctor` after changing configuration.
