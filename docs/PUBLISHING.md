# Publishing

## Local validation

```sh
npm run smoke
npm run doctor
npm run pack:dry
```

## GitHub release

```sh
git add .
git commit -m "Release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

Users can install with:

```sh
pi install git:github.com/YOUR_USER/pi-voice@v0.1.0
```

## npm release

Make sure `package.json` has the correct `name`, `version`, `license`, `keywords`, and `pi.extensions` manifest.

```sh
npm login
npm publish --access public
```

Users can install with:

```sh
pi install npm:pi-voice
```

## Pi package gallery

The package gallery discovers packages tagged with the `pi-package` keyword. Add an `image` or `video` field under `pi` in `package.json` when preview assets are available.
