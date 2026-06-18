# Usage

## Start voice mode

```text
/voice
```

This clears the prompt editor and enters persistent hold-Space voice mode.

- Hold `Space` to record.
- Release `Space` to stop recording and transcribe.
- The transcript is inserted into the prompt editor for review.
- Voice mode stays enabled for the next dictation.
- Type `/voice` again or `/voice off` to exit voice mode.

## Commands

```text
/voice              Toggle persistent hold-Space voice mode
/voice start        Start recording immediately
/voice stop         Stop, transcribe, and insert
/voice cancel       Cancel active recording/transcription
/voice off          Exit voice mode
/voice status       Show current state
/voice doctor       Check setup
/voice devices      List macOS ffmpeg audio devices
/voice help         Show help
```

## Important behavior

Pi Voice never submits the prompt. Always review dictated text before pressing Enter.
