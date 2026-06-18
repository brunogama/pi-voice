# Security Policy

Pi Voice records microphone audio and can optionally send that audio to an OpenAI-compatible transcription endpoint. Security and privacy reports are welcome.

## Supported versions

Security fixes target the latest released version. Before public package publication, treat `main` as the supported development branch.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities involving secret leakage, unsafe uploads, temp audio retention, or command execution.

Instead, contact the maintainer privately through the repository owner's preferred security contact. If no private contact is listed, open a minimal public issue asking for a private reporting channel without disclosing exploit details.

## Security expectations

- Default transcription is local-only (`whisper-cli`).
- Cloud transcription requires explicit `PI_VOICE_BACKEND=openai-compatible`.
- Endpoint credentials must never be logged or displayed.
- Remote HTTP endpoints are rejected; HTTP is allowed only for loopback hosts.
- Redirects are disabled for cloud upload requests.
- Temp WAV files should be deleted on stop, cancel, error, timeout, reload, shutdown, and agent start.
- Dictated text is inserted into the prompt for review; it is not auto-submitted.
