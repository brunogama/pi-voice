# Privacy

Pi Voice handles microphone audio, so privacy is a core design constraint.

## Defaults

- Default backend is local `whisper-cli`.
- `OPENAI_API_KEY` alone does not enable cloud transcription.
- Dictated text is inserted into the prompt editor for review; it is not auto-submitted.

## Cloud upload

Cloud upload happens only when you explicitly set:

```sh
export PI_VOICE_BACKEND=openai-compatible
```

When enabled, audio is uploaded to `PI_VOICE_ENDPOINT`. The extension rejects URL credentials, rejects non-HTTPS remote endpoints, allows HTTP only for loopback hosts, and disables redirects for upload requests.

## Temporary audio

Temporary WAV files are stored in the system temp directory under `pi-voice-*` directories and are deleted after stop, cancel, error, timeout, reload, shutdown, or agent start.

## What not to share in issues

Do not share API keys, Authorization headers, private audio, or sensitive dictated content.
