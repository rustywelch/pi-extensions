# pi-extensions

Three extensions for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install npm:@rustywelch/pi-extensions
```

Pin a version with `@1.0.3`. Try it for one session without installing:

```bash
pi -e npm:@rustywelch/pi-extensions
```

## context-awareness

Pi shows context usage in its footer, but the model never sees it. This extension tells the model how
full its context window is on every request, and lets it compact itself at a sensible moment.

- **A context note on every model request**, including each step of a multi-tool run: tokens used,
  window size, percent, and the distance to Pi's auto-compaction (read from your compaction settings,
  including per-model overrides). The note is added only to the request and never saved to the session,
  so it does not fill the transcript or break prompt caching.
- **Warnings** at 70% (prefer targeted reads, save findings to files) and 90% (finish the step, write
  results now).
- **Self-compaction.** From 70% full, the note suggests compacting at a clean boundary: task finished,
  tests green, notes saved. The `compact_now` tool takes `keep` and `next_step`, queues Pi's own
  compaction with matching instructions, ends the turn, and sends one automatic resume message when
  compaction finishes, so the model continues on its own.
- **Resume verification.** Before compaction it records the working directory, Git branch, HEAD,
  upstream tracking ref, and dirty paths. The automatic resume labels that checkpoint as historical
  and requires fresh verification of Git plus task-critical permissions, CI, deployments, and APIs
  before the model edits or writes anything.
- **Guards:** no compaction below 70% full, no repeat until context grows 20 more points, at most five
  automatic resumes per session, and no resume if compaction fails.
- **Extras:** a `context_status` tool, a `/context-note` command that shows the note the model will see
  next, and `/compact-now` to run the same focused compaction yourself without the automatic resume.

Set `PI_COMPACT_MIN_PERCENT=0` to test self-compaction in a short session.

## search

Pi ships with read, bash, edit, and write, so every search costs a shell round trip. This adds one
`search` tool with two modes: `content` greps for a pattern inside files, and `files` lists files that
match a name glob. It uses ripgrep when it is installed and falls back to grep and find otherwise.

## ios-simulator

One `ios_simulator` tool for driving the iOS Simulator, the same loop Claude and ChatGPT use: build, launch,
look, act, look again.

- **Through `xcrun simctl` (ships with Xcode):** `list`, `boot`, `show` (opens the Simulator window, or Device Hub on Xcode 27, so you can watch and drive the device yourself, for example to enter credentials), `shutdown`, `launch` (installs a built `.app`
  first when you give `app_path`), `terminate`, `open_url`, and `screenshot`, which comes back as an image the
  model can see.
- **Through [AXe](https://github.com/cameroncooke/AXe) (`brew install cameroncooke/axe/axe`):** `tap` (by coordinates, accessibility label or id), `swipe`,
  `type`, `button`, and `describe_ui`, which returns the accessibility tree with element frames so the model
  can aim taps instead of guessing from pixels. `simctl` cannot inject touch input, which is why AXe is needed.
  Without it the other actions still work and the input actions say how to install it.

Coordinates are device points, origin top-left. You need an installed iOS runtime (`xcodebuild -downloadPlatform iOS`).

## License

MIT
