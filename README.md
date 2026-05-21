# PodPics

Tailnet app at `/podpics` for podcast image-overlay workflow.

## Current capabilities

### 1) Workspace-first storage (Dropbox removed from default flow)
PodPics now defaults to a workspace-local root automatically derived from the agent folder:

- `<agent-workspace>/podpics-workspace/`

Main folders:

- `inbox/` — drop videos/transcripts/images here (Obsidian Sync, Syncthing, etc.)
- `projects/` — saved PodPics projects
- `assets/` — optional image pool library
- `outputs/timelines-tests/` — generated OTIO/FCPXML runs
- `Timelines/` — template OTIO/FCPXML files used by generator

This path is per-instance, so James (or any teammate) gets the same behavior on their own agent workspace.

### 2) Persistent project system (filesystem)
Projects are saved under:
- `projects/`

Each project stores:
- `project.json` (full UI state)
- `transcript.md` (saved transcript text)

Project APIs:
- `GET /podpics/api/projects`
- `GET /podpics/api/project?id=<id>`
- `POST /podpics/api/project`
- `POST /podpics/api/project/delete` (delete one project)

### 3) Prompt/style presets (filesystem)
Preset file:
- `projects/prompt-presets.json`

Defaults:
- `reference_book` (2)
- `philosopher_glitch` (3)
- `meme_commentary` (5)
- `evidence_support` (2)

APIs:
- `GET /podpics/api/prompt-presets`
- `POST /podpics/api/prompt-presets`

### 4) UI editing controls
- Project Home screen (create/open/delete) + editor mode
- Create new project asks for name first
- No default video pre-selected; user picks from inbox dropdown
- Autosave (debounced)
- Step-by-step flow:
  1) Select video
  2) Generate transcript (real STT job)
  3) Generate recommended images
- Select style preset per section
- Append candidates (`+1/+2/+3/+5`) without replacing existing
- Delete candidate image (`X`)
- Add entirely new section from selected transcript range
- Remove entire section
- Clear all sections button
- Clear saved projects button (archives then resets index)
- Delete single project with confirmation

### 5) Source video options
- Choose existing raw video from `<storageRoot>/inbox` recursively (`GET /podpics/api/videos`)
- Optional web upload for small files (`POST /podpics/api/upload-video`)
  - uploads are saved under `inbox/<project-id>/`
  - upload limit exposed by `/api/config`

### 6) Resolve test timeline generation
`POST /podpics/api/generate-test` supports:
- `rawVideo`
- `overlayImage`
- `label`
- `offsetSeconds`
- `durationSeconds`
- `overlayZoom`
- `overlayPan`
- `overlayTilt`

Generator uses workspace storage root (no fixed Dropbox path required).

### 7) Bootstrap data endpoint
- `GET /podpics/api/bootstrap` returns:
  - transcript lines
  - initial section recommendations
  - prompt presets
  - available image pools

Output folder:
- `<storageRoot>/outputs/timelines-tests/<run-folder>/`

Recommended file for Resolve:
- `podpics-test-clean.otio`

## Transcript + recommendation APIs (new)
- `POST /podpics/api/transcript/generate` (starts background STT job)
- `GET /podpics/api/transcript/job?id=<jobId>[&includeLines=1]` (poll status/results)
- `POST /podpics/api/recommendations` (build transcript-based recommendation sets)

## Setup

1. Copy the example config:
   ```bash
   cp podpics-server-config.example.json podpics-server-config.json
   ```
2. Edit `podpics-server-config.json` and set `storageRoot` (where projects + outputs go) and `customRoots` (extra dirs the app may read videos from, e.g. a Dropbox or Syncthing folder).
3. Start the server.

## Run locally
```bash
node server.mjs
```

Default bind: `127.0.0.1:8792` with base path `/podpics`.

## Environment variables

- `PODPICS_HOST` (default `127.0.0.1`)
- `PODPICS_PORT` (default `8792`)
- `PODPICS_LOCAL_STT_URL` (default `http://127.0.0.1:9099/v1/audio/transcriptions`)
- `PODPICS_STT_MODEL` (default `distil-large-v3`)
- `PODPICS_LEGACY_DROPBOX_ROOT` (optional, legacy migration path)
