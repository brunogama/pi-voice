# Installation

## Install from local checkout

```sh
pi install /Users/bruno/Developer/pi-voice
```

Restart Pi or run `/reload`.

## Install from GitHub

After the repository is published and tagged:

```sh
pi install git:github.com/YOUR_USER/pi-voice@v0.1.0
```

## Install from npm

After publishing to npm:

```sh
pi install npm:pi-voice
```

## Runtime dependencies

Pi Voice does not install runtime dependencies for you.

For microphone capture:

```sh
brew install ffmpeg
```

For local transcription:

```sh
brew install whisper-cpp
mkdir -p ~/.pi/models
curl -L -o ~/.pi/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then run inside Pi:

```text
/voice doctor
```
