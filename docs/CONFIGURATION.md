# Configuration

Pi Voice is configured with environment variables.

## Capture

```sh
export PI_VOICE_FFMPEG=ffmpeg
export PI_VOICE_FFMPEG_FORMAT=avfoundation
export PI_VOICE_FFMPEG_INPUT=:0
export PI_VOICE_MAX_SECONDS=120
export PI_VOICE_SPACE_RELEASE_MS=850
```

`PI_VOICE_SPACE_RELEASE_MS` controls how long Pi waits after the last repeated Space key before treating Space as released. Terminals do not expose true key-up events.

## Local transcription

Local transcription is the default.

```sh
export PI_VOICE_BACKEND=whisper-cli
export PI_VOICE_WHISPER_BIN=whisper-cli
export PI_VOICE_WHISPER_MODEL=~/.pi/models/ggml-base.en.bin
```

## OpenAI-compatible transcription

Cloud transcription is opt-in only.

```sh
export PI_VOICE_BACKEND=openai-compatible
export OPENAI_API_KEY=...
export PI_VOICE_ENDPOINT=https://api.openai.com/v1/audio/transcriptions
export PI_VOICE_MODEL=whisper-1
```

Loopback HTTP endpoints are allowed for local servers:

```sh
export PI_VOICE_ENDPOINT=http://localhost:10301/v1/audio/transcriptions
```

## Editor insertion

```sh
export PI_VOICE_INSERT_MODE=paste   # default
export PI_VOICE_TRAILING_SPACE=1
```

Use `append` mode if paste handling is not desired:

```sh
export PI_VOICE_INSERT_MODE=append
```
