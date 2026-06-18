# Contributing to Pi Voice

Thanks for your interest in improving Pi Voice. This project is a small Pi extension, so contributions should stay focused, easy to review, and safe by default.

## Development setup

1. Install Pi and clone this repository.
2. Install the runtime tools you want to test with:
   - `ffmpeg` for microphone capture.
   - `whisper-cpp` and a GGML model for local transcription.
3. Run local smoke checks:

```sh
npm run smoke
npm run doctor
npm run pack:dry
```

## Local testing

Load the extension directly from the checkout:

```sh
pi -e ./extensions/voice.ts
```

Inside Pi:

```text
/voice doctor
/voice
```

Manual microphone tests are acceptable, but do not require cloud credentials for routine review.

## Contribution guidelines

- Keep the default path local/private: do not silently switch to cloud transcription.
- Do not add runtime dependencies unless there is a clear need and they are documented.
- Keep temp audio cleanup explicit for stop, cancel, error, timeout, reload, shutdown, and agent start.
- Do not auto-submit dictated prompts; inserted text must remain reviewable by the user.
- Keep changes small and include validation output in the PR description.

## Pull request checklist

- [ ] `npm run smoke` passes.
- [ ] `npm run doctor` output is understood and documented if environment-dependent.
- [ ] `npm run pack:dry` includes the expected files.
- [ ] README/docs are updated for user-visible behavior changes.
- [ ] Privacy/security implications are described.
