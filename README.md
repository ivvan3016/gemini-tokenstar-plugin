<div align="center">

<img src="plugin/assets/logo.svg" alt="TokenStar Logo" width="108" height="108" />

# TokenStar

**Interactive WebGL 1.0 Starry-Sky Observatory & Token Analytics for Antigravity**

[![Release](https://img.shields.io/github/v/release/ivvan3016/gemini-tokenstar-plugin?style=flat-square&color=a855f7)](https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/latest)
[![GitHub Stars](https://img.shields.io/github/stars/ivvan3016/gemini-tokenstar-plugin?style=flat-square&color=f59e0b)](https://github.com/ivvan3016/gemini-tokenstar-plugin/stargazers)
[![Antigravity MCP App](https://img.shields.io/badge/Antigravity-MCP%20App-38bdf8?style=flat-square)](plugin/plugin.json)
[![Python 3.12–3.13](https://img.shields.io/badge/Python-3.12%E2%80%933.13-3776ab?style=flat-square)](backend/pyproject.toml)
[![React 19 + WebGL](https://img.shields.io/badge/Frontend-React%2019%20%2B%20WebGL-61dafb?style=flat-square)](frontend/package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)](LICENSE)

**English** | [简体中文](README_zh.md)

</div>

---

**TokenStar** transforms your local Antigravity & Gemini conversation logs into a living, interactive planetarium sky. Every model request becomes an optically rendered star grouped with sibling requests from the same conversation into non-overlapping astronomical constellations, while an integrated analytics view tracks model token breakdown, daily heatmaps, and per-conversation telemetry.

It runs natively as an **Antigravity MCP App plugin** (`tokenstar-mcp`) directly inside Antigravity's conversation, side pane, or full-page sidebar view, as well as in **Standalone Web Mode** (`tokenstar-web`) in any desktop browser.

<div align="center">
  <img src="assets/preview-sky.png" alt="TokenStar Live WebGL Starry Sky Panorama" width="100%" />
  <br />
  <sub>Panoramic WebGL sky mapping model requests &amp; conversations into O–M spectral stars, pulsars, comets, and lensed black holes</sub>
  <br /><br />
  <img src="assets/preview-detail.png" alt="TokenStar Subagent Companion Clusters & Detail Drawer" width="100%" />
  <br />
  <sub>Focused constellation view with unfolded subagent companion globular clusters, tidal bridges, and request telemetry drawer</sub>
</div>

## Highlights

- **Your Token Usage as a Living Starry Sky:** Every model request becomes a real-time WebGL star, and every conversation connects into its own constellation across a deep galactic panorama.
- **Five Cosmic Forms & Companion Clusters:** Conversations and requests naturally take shape as main-sequence stars, orbiting binary stars & subagent clusters, pulsars, lensed black holes, and comets based on how you work with AI.
- **Brightness & Color Driven by Telemetry:** Higher token usage shines brighter and larger, while different model families glow across real stellar blackbody hues from sapphire blue to warm crimson.
- **Explore, Analyze & Share:** Smoothly pan and zoom your sky, replay your coding history over time, inspect daily heatmaps and token breakdowns, and export 2x PNG starry-sky wallpapers or commemorative cards.
- **100% Local & Built for Antigravity:** Strictly read-only local log scanning with zero telemetry; runs natively inside Antigravity (with built-in update checks) or standalone in any browser.

## Astronomical Encoding

### Celestial Classification (Strict Priority)

| Celestial Type | Visual Form in WebGL | Request Rule | Conversation Rule |
| :--- | :--- | :--- | :--- |
| **Black Hole** | Tilted Interstellar-style gravitational lensing disk + photon ring | Status in `ERROR`, `FAILED`, `CANCELLED`, or `ABORTED` | Terminal error status or error steps `>= 30%` |
| **Binary Star** | Keplerian orbiting pair with complementary hues + Roche plasma bridge | Calls `>= 1` subagent (`invoke_subagent` / `swarm`) | Calls `>= 1` subagent across tree |
| **Pulsar** | Oblique rotator with steady spin-axis torus & precessing Doppler jets | High-frequency tools (`tool_calls >= 8`) | Cumulative tools `>= 40` |
| **Comet** | Elliptical coma + dusty fan tail & plasma disconnection wave knots | Lightweight turn (`tool_calls == 0` & `< 15K` tokens) | `<= 2` turns, `<= 2` tools, and `< 50K` tokens |
| **Main-Sequence Star** | Optical Moffat PSF core + corona, halo, and bright-giant diffraction spikes | All remaining reasoning requests | All remaining deep conversations |

### Brightness & Color Mapping

- **Brightness & Core Radius (Token Usage):** Combines dataset-wide `p05`–`p98` relative log-token quantiles (`0.82` weight) with absolute `(log10(tokens) - 3.0) / 3.0` magnitude (`0.18` weight), mapping requests across `[0.12, 1.0]` magnitude and nonlinear `0.9–5.4 px` PSF core radii with intensity-scaled coronae, diffraction spikes, and lens streaks.
- **Spectral Color (Model + H-R Blackbody Temperature):** Anchors each model family along the **O-B-A-F-G-K-M** blackbody curve (`#68a4ff` → `#94c4ff` → `#dcebff` → `#fff5de` → `#ffdc84` → `#ffa654` → `#ff6e46`) while introducing deterministic per-star H-R temperature variation for realistic cosmic color diversity.

## Architecture

```mermaid
flowchart LR
  Logs["Local Brain Logs (~/.gemini/antigravity/brain)"] -->|"Read-only scan + in-memory cache"| Backend["Python Backend (scanner, classifier)"]
  Backend -->|"tokenstar-mcp (stdio / SEP-1865)"| Host["Antigravity MCP App Iframe"]
  Backend -->|"tokenstar-web (HTTP / Starlette)"| Browser["Standalone Browser"]
  Bundle["Single-File UI (dist/app.html)"] -->|"ui://tokenstar/app.html"| Host
  Bundle -->|"GET /"| Browser
  Host -->|"open_tokenstar / tokenstar_get_sky_data"| UI["React 19 + WebGL 1.0 Sky"]
  Browser -->|"GET /api/sky-data"| UI
```

## Privacy & Local Read-Only Guarantees

- **Strictly Read-Only Log Scanning:** Reads `~/.gemini/antigravity/brain` (overridable via `TOKENSTAR_BRAIN_DIR` or `--brain-dir`) and `~/.gemini/tmp` without creating, modifying, or deleting any conversation or Antigravity state files.
- **No Host Config Mutation:** Installation only writes inside the isolated target plugin directory (`~/.gemini/config/plugins/tokenstar`) and never edits `~/.gemini/config/config.json` or Antigravity binaries.
- **100% Offline Single-File UI & Opt-In Updates:** `dist/app.html` bundles React, `@modelcontextprotocol/ext-apps`, WebGL shaders, and styles into a single self-contained HTML file (`< 10 MiB`, ~883 KiB) with zero external CDN or telemetry requests. The only optional outbound network call is checking/downloading a new GitHub Release when you explicitly click "Check for Updates".
- **Ephemeral In-Memory Cache:** File fingerprints and computed star rollups stay strictly in server memory during execution.

## Prerequisites

- **Prebuilt Release Install (Recommended):** Only [`uv`](https://docs.astral.sh/uv/) is required (`uv` automatically manages Python 3.12–3.13; **no Node.js required**).
- **Building from Source / Development:** [`uv`](https://docs.astral.sh/uv/) + **Node.js (>= 20) & npm** (automatically picked up from `.tools/nodejs` if present) + **Git**.
- **Antigravity:** Required for MCP App plugin mode (`uv` must be visible on your system `PATH` when Antigravity launches `tokenstar-mcp`). Standalone Web Mode runs without Antigravity.

## Quick Start

### Option A — Fast Install from Prebuilt Release (Recommended, No Node.js Needed)

Download the prebuilt `tokenstar-plugin.zip` asset from [GitHub Releases](https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/latest), extract it into `~/.gemini/config/plugins/tokenstar`, and sync the isolated server environment:

#### Windows (PowerShell)

```powershell
$dest = Join-Path $HOME '.gemini\config\plugins\tokenstar'
$zip = Join-Path $env:TEMP 'tokenstar-plugin.zip'
Invoke-WebRequest 'https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/latest/download/tokenstar-plugin.zip' -OutFile $zip
foreach ($p in 'plugin.json','mcp_config.json','assets','dist','server\pyproject.toml','server\uv.lock','server\src') { Remove-Item -Recurse -Force (Join-Path $dest $p) -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
uv --project (Join-Path $dest 'server') sync --no-dev
```

#### macOS / Linux

```bash
DEST="$HOME/.gemini/config/plugins/tokenstar"
TMP_ZIP="$(mktemp -t tokenstar-plugin.XXXXXX.zip)"
curl -fL 'https://github.com/ivvan3016/gemini-tokenstar-plugin/releases/latest/download/tokenstar-plugin.zip' -o "$TMP_ZIP"
rm -rf "$DEST/plugin.json" "$DEST/mcp_config.json" "$DEST/assets" "$DEST/dist" "$DEST/server/pyproject.toml" "$DEST/server/uv.lock" "$DEST/server/src"
mkdir -p "$DEST" && unzip -o "$TMP_ZIP" -d "$DEST" && rm -f "$TMP_ZIP"
uv --project "$DEST/server" sync --no-dev
```

#### Install with an Antigravity Agent

Paste this prompt to your Antigravity Agent to have it install TokenStar directly:

> Install the TokenStar plugin from https://github.com/ivvan3016/gemini-tokenstar-plugin into `~/.gemini/config/plugins/tokenstar` (prefer the `tokenstar-plugin.zip` asset from the latest GitHub Release so Node.js is unnecessary, or clone the repo and run `scripts/install.py` / `scripts/install-plugin.ps1` / `scripts/install-plugin.sh`), then run `uv --project ~/.gemini/config/plugins/tokenstar/server sync --no-dev`. Do not modify `~/.gemini/config/config.json`.

Expected layout inside `~/.gemini/config/plugins/tokenstar`:

```text
~/.gemini/config/plugins/tokenstar/
├── plugin.json
├── mcp_config.json
├── assets/
│   └── logo.svg
├── dist/
│   └── app.html
└── server/
    ├── pyproject.toml
    ├── uv.lock
    └── src/
```

### Option B — Install from Source (Windows / macOS / Linux)

Clone the repository and run the single installer command for your OS (first-time runs automatically install `frontend/node_modules`, compile `dist/app.html`, stage `~/.gemini/config/plugins/tokenstar`, and run `uv sync --no-dev`):

```bash
git clone https://github.com/ivvan3016/gemini-tokenstar-plugin.git
cd gemini-tokenstar-plugin
```

- **Windows (PowerShell):**

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1
  ```

- **macOS / Linux:**

  ```bash
  bash scripts/install-plugin.sh
  ```

- **Cross-platform Python (`scripts/install.py`):**

  ```bash
  uv run --no-project python scripts/install.py
  ```

Installer options:

| Windows (`install-plugin.ps1`) | macOS / Linux (`install-plugin.sh`) | Cross-Platform (`install.py`) | Description |
| :--- | :--- | :--- | :--- |
| `-TargetDir <path>` | `--target-dir <path>` | `--target-dir <path>` | Override installation directory (default: `~/.gemini/config/plugins/tokenstar`) |
| `-Verify` | `--verify` | `--verify` | Run full TypeScript, Vitest, and Pytest checks while building from source |
| `-SkipBuild` | `--skip-build` | `--skip-build` | Stage using an existing `dist/app.html` without rebuilding |
| `-SkipSync` | `--skip-sync` | `--skip-sync` | Skip `uv --project <TargetDir>/server sync --no-dev` (for offline staging) |
| — | — | `--from-release [TAG]` | Download and install prebuilt `tokenstar-plugin.zip` from GitHub Releases (defaults to `latest`) |
| — | — | `--from-zip <path>` | Install from a local prebuilt `tokenstar-plugin.zip` archive |
| — | — | `--pack <output.zip>` | Build (unless `--skip-build`) and create a portable release zip archive |

#### Open TokenStar in Antigravity

Once staged, Antigravity automatically discovers the plugin:

- Click **TokenStar** in the Antigravity left sidebar for the full-page observatory (`global` entrypoint).
- Open **TokenStar** from the right side pane `+` menu (`aux_pane` entrypoint).
- Or ask the agent in chat to open TokenStar (`open_tokenstar`).

#### In-Plugin Updates (`v0.1.2+`)

Click the update button in the top navigation bar to check GitHub Releases and upgrade in-place:

- **Frontend-only updates:** Apply immediately the next time you reopen the TokenStar view.
- **Backend changes included:** Restart Antigravity (`关闭并重新打开`) after updating so the updated Python MCP server reloads cleanly.

#### Uninstall Plugin

Remove the isolated directory directly (no global config changes to revert):

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$HOME\.gemini\config\plugins\tokenstar"
```

```bash
# macOS / Linux
rm -rf "$HOME/.gemini/config/plugins/tokenstar"
```

### Option C — Standalone Web Mode

If `dist/app.html` has not been built yet, build the frontend bundle once and launch the local Starlette observatory server:

```bash
npm --prefix frontend ci && npm --prefix frontend run build
uv --project backend run tokenstar-web --open
```

Available CLI options for `tokenstar-web`:

| Option | Default | Description |
| :--- | :--- | :--- |
| `--brain-dir <path>` | `~/.gemini/antigravity/brain` | Override read-only log root (or env `TOKENSTAR_BRAIN_DIR`) |
| `--host <addr>` | `127.0.0.1` | Bind host address |
| `--port <num>` | `18420` | Starting port (scans up to 20 consecutive ports if busy) |
| `--html-path <path>` | `dist/app.html` | Override compiled UI HTML path (or env `TOKENSTAR_APP_HTML`) |
| `--open` | `false` | Open the observatory URL automatically in the default browser |

## Development & Verification

Run the full build and verification pipeline on Windows (automatically installs `frontend/node_modules` if missing, then runs TypeScript `tsc --noEmit`, Vitest suite, Vite single-file build & external-URL audit, and backend Pytest suite; pass `-SkipTests` for build-only):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

Or run cross-platform frontend / backend suites individually:

```bash
npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run test
npm --prefix frontend run build
uv --project backend run pytest backend/tests -v
```

## Project Structure

```text
tokenstar-plugin/
├── backend/
│   ├── src/tokenstar/
│   │   ├── sources/        # Read-only Antigravity & Gemini CLI transcript adapters
│   │   ├── classifier.py   # Priority-ordered celestial classifier
│   │   ├── config.py       # Classification thresholds & path defaults
│   │   ├── scanner.py      # Subagent tree & parent-request rollup + cache
│   │   ├── updater.py      # GitHub Release update check & safe in-place updater
│   │   ├── mcp_server.py   # SEP-1865 MCP App stdio server (tokenstar-mcp)
│   │   └── web_server.py   # Standalone HTTP server (tokenstar-web)
│   └── tests/              # Pytest unit & server integration tests
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── sky/        # WebGL 1.0 sky renderer, overlay canvas, HUD, drawer
│   │   │   ├── stats/      # Heatmap, token breakdown & sortable session tables
│   │   │   ├── TopBar.tsx  # Navigation bar, live refresh & update trigger
│   │   │   └── UpdateModal.tsx # In-plugin update status & one-click upgrade modal
│   │   ├── logic/          # Layout physics, MST constellations, metrics & filters
│   │   └── services/       # Dual-mode MCP App + HTTP transport
│   └── package.json
├── plugin/
│   ├── assets/logo.svg     # Plugin card & navigation emblem
│   ├── mcp_config.json     # ${PLUGIN_ROOT} MCP server manifest
│   └── plugin.json         # Antigravity plugin metadata & suggested prompts
├── scripts/
│   ├── build.ps1           # Full verification & single-file HTML build script
│   ├── install.py          # Cross-platform source installer & release packager
│   ├── install-plugin.ps1  # Windows isolated plugin bundler & uv runtime sync
│   └── install-plugin.sh   # macOS / Linux isolated plugin bundler & uv runtime sync
├── LICENSE                 # MIT License
├── README.md               # English documentation
└── README_zh.md            # 简体中文文档
```

## License

Licensed under the [MIT License](LICENSE).
