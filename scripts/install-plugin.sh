#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/.gemini/config/plugins/tokenstar"
SKIP_BUILD=0
SKIP_SYNC=0
VERIFY=0

usage() {
  cat <<'EOF'
Usage: install-plugin.sh [OPTIONS]

Build and install TokenStar as an Antigravity MCP App plugin on macOS / Linux.

Options:
  --target-dir <path>  Override installation directory (default: ~/.gemini/config/plugins/tokenstar)
  --skip-build         Stage using an existing dist/app.html without rebuilding
  --skip-sync          Skip `uv --project <target>/server sync --no-dev`
  --verify             Run full frontend (tsc + vitest) and backend (pytest) suites during build
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-dir)
      if [[ $# -lt 2 ]]; then
        echo "Error: --target-dir requires a path argument." >&2
        exit 2
      fi
      TARGET_DIR="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-sync)
      SKIP_SYNC=1
      shift
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'. Use --help for usage." >&2
      exit 2
      ;;
  esac
done

if [[ -z "${TARGET_DIR//[[:space:]]/}" ]]; then
  echo "Error: Target directory cannot be empty." >&2
  exit 1
fi

case "$TARGET_DIR" in
  "~") TARGET_DIR="$HOME" ;;
  "~/"*) TARGET_DIR="$HOME/${TARGET_DIR#\~/}" ;;
esac

# Normalize trailing slashes safely while rejecting filesystem root '/'
TARGET_DIR="${TARGET_DIR%/}"
if [[ -z "$TARGET_DIR" ]]; then
  echo "Error: Refusing to install directly into filesystem root '/'." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
BACKEND_DIR="$REPO_ROOT/backend"
APP_HTML="$REPO_ROOT/dist/app.html"

if [[ -d "$REPO_ROOT/.tools/nodejs/bin" ]]; then
  export PATH="$REPO_ROOT/.tools/nodejs/bin:$PATH"
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  command -v npm >/dev/null 2>&1 || {
    echo "Error: npm not found on PATH (Node.js >= 20 is required to build from source)." >&2
    exit 1
  }

  if [[ ! -x "$FRONTEND_DIR/node_modules/.bin/tsc" || ! -x "$FRONTEND_DIR/node_modules/.bin/vite" ]]; then
    if [[ -f "$FRONTEND_DIR/package-lock.json" ]]; then
      echo "==> Installing frontend dependencies (npm ci)"
      npm --prefix "$FRONTEND_DIR" ci
    else
      echo "==> Installing frontend dependencies (npm install)"
      npm --prefix "$FRONTEND_DIR" install
    fi
  fi

  if [[ "$VERIFY" -eq 1 ]]; then
    echo "==> Frontend TypeScript check"
    npm --prefix "$FRONTEND_DIR" run typecheck
    echo "==> Frontend Vitest suite"
    npm --prefix "$FRONTEND_DIR" run test
  fi

  echo "==> Frontend single-file production build"
  npm --prefix "$FRONTEND_DIR" run build
fi

echo "==> Validating dist/app.html"
if [[ ! -f "$APP_HTML" ]]; then
  echo "Error: Expected compiled frontend artifact not found: $APP_HTML" >&2
  exit 1
fi

APP_SIZE="$(wc -c < "$APP_HTML" | tr -d '[:space:]')"
if [[ "$APP_SIZE" -le 0 ]]; then
  echo "Error: dist/app.html is empty: $APP_HTML" >&2
  exit 1
fi
if [[ "$APP_SIZE" -ge 10485760 ]]; then
  echo "Error: dist/app.html exceeds 10 MiB limit (${APP_SIZE} bytes): $APP_HTML" >&2
  exit 1
fi

if grep -Eiq '<(script|link)[^>]+(src|href)=["'\'']?(https?:)?//' "$APP_HTML"; then
  echo "Error: dist/app.html contains an external <script> or <link> URL." >&2
  exit 1
fi
if grep -Eiq '(@import[[:space:]]+(url\(|["'\''])|url\(["'\'']?(https?:)?//)' "$APP_HTML"; then
  echo "Error: dist/app.html contains an external CSS @import or url(...) reference." >&2
  exit 1
fi

if [[ "$SKIP_BUILD" -eq 0 && "$VERIFY" -eq 1 ]]; then
  command -v uv >/dev/null 2>&1 || {
    echo "Error: uv not found on PATH (required for --verify backend pytest)." >&2
    exit 1
  }
  echo "==> Backend Pytest suite"
  uv --project "$BACKEND_DIR" run pytest "$BACKEND_DIR/tests" -v
fi

for required in \
  "$REPO_ROOT/plugin/plugin.json" \
  "$REPO_ROOT/plugin/mcp_config.json" \
  "$REPO_ROOT/plugin/assets" \
  "$APP_HTML" \
  "$BACKEND_DIR/pyproject.toml" \
  "$BACKEND_DIR/uv.lock" \
  "$BACKEND_DIR/src"
do
  if [[ ! -e "$required" ]]; then
    echo "Error: Required plugin build input missing: $required" >&2
    exit 1
  fi
done

echo "==> Staging TokenStar plugin into $TARGET_DIR"
mkdir -p "$TARGET_DIR"

for managed in plugin.json mcp_config.json assets dist server; do
  rm -rf "$TARGET_DIR/$managed"
done

mkdir -p "$TARGET_DIR/dist" "$TARGET_DIR/server"
cp "$REPO_ROOT/plugin/plugin.json" "$TARGET_DIR/plugin.json"
cp "$REPO_ROOT/plugin/mcp_config.json" "$TARGET_DIR/mcp_config.json"
cp -R "$REPO_ROOT/plugin/assets" "$TARGET_DIR/assets"
cp "$APP_HTML" "$TARGET_DIR/dist/app.html"
cp "$BACKEND_DIR/pyproject.toml" "$TARGET_DIR/server/pyproject.toml"
cp "$BACKEND_DIR/uv.lock" "$TARGET_DIR/server/uv.lock"
cp -R "$BACKEND_DIR/src" "$TARGET_DIR/server/src"

for subdir in "$TARGET_DIR/assets" "$TARGET_DIR/server/src"; do
  find "$subdir" -type d \( -name '__pycache__' -o -name '.venv' -o -name '.pytest_cache' -o -name 'tests' \) -prune -exec rm -rf {} +
  find "$subdir" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
done

if [[ "$SKIP_SYNC" -eq 0 ]]; then
  command -v uv >/dev/null 2>&1 || {
    echo "Error: uv not found on PATH. Install uv (https://docs.astral.sh/uv/) or pass --skip-sync." >&2
    exit 1
  }
  echo "==> Syncing isolated Python environment in $TARGET_DIR/server"
  if ! uv --project "$TARGET_DIR/server" sync --no-dev; then
    echo "Warning: uv sync --no-dev failed; retrying with --offline using local uv cache." >&2
    if ! uv --project "$TARGET_DIR/server" sync --no-dev --offline; then
      echo "Error: uv sync --no-dev failed (and --offline fallback failed). Pass --skip-sync for offline staging." >&2
      exit 1
    fi
  fi
else
  echo "==> Skipping uv sync (--skip-sync specified)."
fi

echo "TokenStar plugin staged cleanly at: $TARGET_DIR"
