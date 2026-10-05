# pi-extensions

Two extensions for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install npm:@rustywelch/pi-extensions
```

Pin a version with `@1.0.1`. Try it for one session without installing:

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
- **Warnings** at 75% (prefer targeted reads, save findings to files) and 90% (finish the step, write
  results now).
- **Self-compaction.** From 60% full, the note suggests compacting at a clean boundary: task finished,
  tests green, notes saved. The `compact_now` tool takes `keep` and `next_step`, queues Pi's own
  compaction with matching instructions, ends the turn, and sends one automatic resume message when
  compaction finishes, so the model continues on its own.
- **Guards:** no compaction below 50% full, no repeat until context grows 20 more points, at most five
  automatic resumes per session, and no resume if compaction fails.
- **Extras:** a `context_status` tool, a `/context-note` command that shows the note the model will see
  next, and `/compact-now` to run the same focused compaction yourself without the automatic resume.

Set `PI_COMPACT_MIN_PERCENT=0` to test self-compaction in a short session.

## search

Pi ships with read, bash, edit, and write, so every search costs a shell round trip. This adds one
`search` tool with two modes: `content` greps for a pattern inside files, and `files` lists files that
match a name glob. It uses ripgrep when it is installed and falls back to grep and find otherwise.

## License

MIT
