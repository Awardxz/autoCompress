# AutoCompress

A [Vencord](https://vencord.dev) plugin that compresses videos with **ffmpeg** when they're too big to upload to Discord, then uploads the smaller file for you.

Drop, paste, or attach a video that's over your upload limit. Normally Discord would say "Your files are too powerful". With AutoCompress, the video is re-encoded to fit and added to your message.

## Features

- **Works with every way of attaching files:** drag & drop, paste, and the **+** button.
- **Knows your real limit:** 20 MB on free accounts, plus Nitro and server boost limits. You can also set your own target size.
- **Two-pass encoding:** ffmpeg runs twice so the file lands close to the target size without going over.
- **Smart downscaling:** long videos are scaled down (1080p → 720p → 480p …) and capped at 30 fps, so they look clean instead of blocky.
- **Retries:** if the first encode overshoots the limit, it tries again at a lower bitrate.
- **Leaves other files alone:** files that are already small enough upload normally.

## Requirements

- Discord desktop or [Vesktop](https://github.com/Vencord/Vesktop) with a **source build of Vencord**. User plugins can't be added to the prebuilt installer version.
- **ffmpeg** installed:
  - Windows: `winget install ffmpeg` or `choco install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: your package manager, e.g. `sudo apt install ffmpeg`

  Or download a build and set its full path in the plugin settings.

## Installation

1. Set up a Vencord source build by following Vencord's [Installing custom plugins](https://docs.vencord.dev/installing/custom-plugins/) guide.
2. Clone this repo into `src/userplugins`. Keep the `.desktop` folder suffix: it tells Vencord the plugin needs the desktop app.

   ```bash
   cd Vencord/src/userplugins
   git clone https://github.com/Awardxz/autoCompress.git autoCompress.desktop
   ```

3. Build and inject:

   ```bash
   pnpm build
   pnpm inject
   ```

4. Restart Discord. Then enable **AutoCompress** under Settings → Vencord → Plugins.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Target size (MB) | `0` | `0` uses your Discord upload limit. Set a number to aim lower. |
| Preset | Faster | The x264 speed/quality trade-off. Slower presets look a bit better at the same size. |
| ffmpeg path | `ffmpeg` | Full path to ffmpeg if it isn't on your `PATH`. |
| Show progress | On | Shows a toast at 25 / 50 / 75 %. |

## How it works

1. Every upload in Discord goes through one internal function (`promptToUpload`), and that function does the "file too large" check. The plugin patches the start of it.
2. If any attached video is over your limit, the plugin takes over that upload. The video's bytes go to Vencord's native (Node) side over IPC.
3. On the native side, ffmpeg reads the video's duration and works out a bitrate:
   `video_kbps = target_bytes × 8 × 0.94 / 1000 / duration − audio_kbps`
4. It runs a two-pass libx264 encode with AAC audio and checks the size. If the file is still too big, it retries with a lower bitrate.
5. The compressed `.mp4` is sent back to Discord's normal upload flow, together with any other files you attached.

## Limitations

- **Very long videos won't fit.** At 20 MB, a 10-minute video only gets about 260 kbps. When a video is below ~40 kbps of video after the budget for audio, the plugin refuses and tells you the longest length that would fit.
- **It's slow on weak PCs.** Encoding takes about as long as the video, or longer, depending on your CPU and preset.
- **Desktop only.** It needs to run ffmpeg as a native program, so it doesn't work on Discord in a browser.
- **Discord updates can break it.** If Discord changes its upload code, the patch stops matching, and Vencord will tell you the plugin's patch failed. Please open an issue if that happens.

## Disclaimer

Client mods are against Discord's Terms of Service. Use at your own risk. AutoCompress only changes files on your own machine before they're uploaded, so the risk is low, but it isn't zero.

## Contributing

Issues and PRs are welcome.

### Dev setup

Keep this repo and a Vencord checkout next to each other, then link the plugin in instead of copying it:

```
projects/
├── Vencord/
└── autoCompress/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Junction -Path Vencord\src\userplugins\autoCompress.desktop -Target autoCompress
```

macOS / Linux:

```bash
ln -s ../../../autoCompress Vencord/src/userplugins/autoCompress.desktop
```

The build follows the link back to this folder, so Vencord's `@api/...` and `@utils/...` imports need Vencord's TypeScript config. Add a `tsconfig.json` here. It's gitignored.

```json
{ "extends": "../Vencord/tsconfig.json" }
```

Then run `pnpm watch` in `Vencord/` and reload Discord with Ctrl+R after each change.

## License

[GPL-3.0-or-later](LICENSE), the same license as Vencord.
