# Troubleshooting

Start with:

```text
/voice doctor
```

## ffmpeg missing

Install or configure ffmpeg:

```sh
brew install ffmpeg
export PI_VOICE_FFMPEG=ffmpeg
```

## macOS microphone permission

Grant microphone permission to your terminal app in System Settings, then restart the terminal/Pi.

## Wrong input device

Run:

```text
/voice devices
```

Then set an input, for example:

```sh
export PI_VOICE_FFMPEG_INPUT=:1
```

## whisper-cli missing or unsupported

Install `whisper-cpp` and run `/voice doctor` again:

```sh
brew install whisper-cpp
```

## Model missing

Download a model and configure it:

```sh
mkdir -p ~/.pi/models
curl -L -o ~/.pi/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
export PI_VOICE_WHISPER_MODEL=~/.pi/models/ggml-base.en.bin
```

## Hold-Space stops too early or too late

Tune release detection:

```sh
export PI_VOICE_SPACE_RELEASE_MS=700
```

Use a larger value if recording stops too early; smaller if transcription starts too slowly after release.
