#!/usr/bin/env bash
#
# PAI Installed Hotfix Updater
#
# Fetches a PAI release bundle, reads hotfix-manifest.json, and overlays only
# the managed files listed there into an existing framework install. It
# intentionally does not touch USER, MEMORY, settings.json, config.toml, auth,
# env files, or hook trust state.

set -euo pipefail

REPO_URL="https://github.com/haydencj/Personal_AI_Infrastructure.git"
BRANCH="pai-codex-flawless-runtime"
FRAMEWORK=""
INSTALL_ROOT=""
AGENTS_SKILLS_ROOT=""
SOURCE_DIR=""
MANIFEST_PATH=""
DRY_RUN=0
NO_PULL=0
KEEP_TEMP=0
TEMP_ROOT=""

info() { printf '  [INFO] %s\n' "$*" >&2; }
success() { printf '  [OK] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*" >&2; }
fail() { printf '  [ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
PAI Installed Hotfix Updater

Usage:
  update-installed.sh [options]

Options:
  --repo-url URL          Git repository to fetch when --source-dir is omitted
  --branch NAME           Git branch to fetch
  --framework NAME        claude, codex, or opencode
  --install-root PATH     Existing framework home to patch
  --source-dir PATH       Local checkout or release root to use
  --manifest-path PATH    Override manifest path
  --dry-run               Show planned updates without writing files
  --no-pull               Do not git fetch/pull when --source-dir is a checkout
  --keep-temp             Keep the temporary clone
  -h, --help              Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-url) REPO_URL="${2:?missing value for --repo-url}"; shift 2 ;;
    --branch) BRANCH="${2:?missing value for --branch}"; shift 2 ;;
    --framework) FRAMEWORK="${2:?missing value for --framework}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?missing value for --install-root}"; shift 2 ;;
    --agents-skills-root) AGENTS_SKILLS_ROOT="${2:?missing value for --agents-skills-root}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing value for --source-dir}"; shift 2 ;;
    --manifest-path) MANIFEST_PATH="${2:?missing value for --manifest-path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-pull) NO_PULL=1; shift ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

cleanup() {
  if [ -n "$TEMP_ROOT" ] && [ "$KEEP_TEMP" -eq 0 ]; then
    case "$TEMP_ROOT" in
      "${TMPDIR:-/tmp}"/pai-hotfix-*|/tmp/pai-hotfix-*) rm -rf -- "$TEMP_ROOT" ;;
    esac
  elif [ -n "$TEMP_ROOT" ]; then
    info "Kept temp checkout: $TEMP_ROOT"
  fi
}
trap cleanup EXIT

absolute_path() {
  local path="$1"
  if [ -d "$path" ]; then
    (cd "$path" && pwd -P)
  else
    local dir base
    dir="$(dirname "$path")"
    base="$(basename "$path")"
    (cd "$dir" && printf '%s/%s\n' "$(pwd -P)" "$base")
  fi
}

normalize_framework() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
  case "$value" in
    claude|claudecode) printf 'claude\n' ;;
    codex|openai|openaicodex) printf 'codex\n' ;;
    opencode) printf 'opencode\n' ;;
    *) printf '\n' ;;
  esac
}

json_tool() {
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
  elif command -v python >/dev/null 2>&1; then
    printf 'python\n'
  elif command -v node >/dev/null 2>&1; then
    printf 'node\n'
  elif command -v bun >/dev/null 2>&1; then
    printf 'bun\n'
  else
    printf '\n'
  fi
}

read_framework_state_at() {
  local data_dir="$1"
  local state_path="$data_dir/framework.json"
  [ -f "$state_path" ] || return 0
  local tool
  tool="$(json_tool)"
  [ -n "$tool" ] || return 0

  if [ "$tool" = "python3" ] || [ "$tool" = "python" ]; then
    "$tool" - "$state_path" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
print("{}\t{}\t{}".format(data.get("active", "") or "", data.get("root", "") or "", data.get("dataDir", "") or ""))
PY
  else
    "$tool" -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(`${data.active||""}\t${data.root||""}\t${data.dataDir||""}`); } catch {}' "$state_path"
  fi
}

read_framework_state() {
  read_framework_state_at "$HOME/.pai"
}

framework_state_usable() {
  local root="${1:-}"
  [ -z "$root" ] || [ -e "$root" ]
}

stale_framework_env() {
  if [ -n "${PAI_FRAMEWORK_DIR:-}" ] && [ ! -e "$PAI_FRAMEWORK_DIR" ]; then
    return 0
  fi
  if [ -n "${PAI_DIR:-}" ] && [ ! -e "$PAI_DIR" ]; then
    return 0
  fi
  return 1
}

resolve_pai_data_dir() {
  local default_data_dir="$HOME/.pai"
  local state active root data_dir
  state="$(read_framework_state || true)"
  root="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $2}')"
  data_dir="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $3}')"

  if [ -n "${PAI_DATA_DIR:-}" ] && [ -e "$PAI_DATA_DIR" ]; then
    local env_state env_root
    env_state="$(read_framework_state_at "$PAI_DATA_DIR" || true)"
    env_root="$(printf '%s' "$env_state" | awk -F '\t' 'NR==1 {print $2}')"
    if { [ -z "$env_state" ] && { ! framework_state_usable "$root" || ! stale_framework_env; }; } || framework_state_usable "$env_root"; then
      absolute_path "$PAI_DATA_DIR"
      return 0
    fi
  fi

  if framework_state_usable "$root" && [ -n "$data_dir" ]; then
    absolute_path "$data_dir"
    return 0
  fi

  absolute_path "$default_data_dir"
}

resolve_pai_config_dir() {
  if [ -n "${PAI_CONFIG_DIR:-}" ] && [ -e "$PAI_CONFIG_DIR" ]; then
    absolute_path "$PAI_CONFIG_DIR"
    return 0
  fi
  printf '%s\n' "$HOME/.config/PAI"
}

resolve_target() {
  local state active root fw
  state="$(read_framework_state || true)"
  active="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $1}')"
  root="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $2}')"

  fw="$(normalize_framework "$FRAMEWORK")"
  if [ -z "$fw" ] && [ -n "${PAI_FRAMEWORK:-}" ]; then fw="$(normalize_framework "$PAI_FRAMEWORK")"; fi
  if [ -z "$fw" ] && [ -n "$active" ]; then fw="$(normalize_framework "$active")"; fi
  if [ -z "$fw" ]; then
    if [ -n "${CODEX_HOME:-}" ] || [ -d "$HOME/.codex" ]; then fw="codex"
    elif [ -n "${CLAUDE_HOME:-}" ] || [ -d "$HOME/.claude" ]; then fw="claude"
    elif [ -n "${OPENCODE_CONFIG_DIR:-}" ] || [ -d "$HOME/.config/opencode" ]; then fw="opencode"
    fi
  fi
  [ -n "$fw" ] || fail "Could not determine framework. Pass --framework codex|claude|opencode."

  local target_root="$INSTALL_ROOT"
  if [ -z "$target_root" ] && [ -n "$active" ] && [ "$(normalize_framework "$active")" = "$fw" ] && [ -n "$root" ]; then
    target_root="$root"
  fi
  if [ -z "$target_root" ]; then
    case "$fw" in
      codex) target_root="${CODEX_HOME:-$HOME/.codex}" ;;
      claude) target_root="${CLAUDE_HOME:-$HOME/.claude}" ;;
      opencode) target_root="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}" ;;
    esac
  fi

  target_root="$(absolute_path "$target_root")"
  [ -d "$target_root" ] || fail "Install root does not exist: $target_root"
  printf '%s\t%s\n' "$fw" "$target_root"
}

resolve_release_root() {
  local path candidate
  path="$(absolute_path "$1")"
  if [ -f "$path/CLAUDE.md" ] && [ -d "$path/PAI" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  candidate="$path/Releases/v5.0.0/.claude"
  if [ -f "$candidate/CLAUDE.md" ] && [ -d "$candidate/PAI" ]; then
    absolute_path "$candidate"
    return 0
  fi
  fail "Could not locate release root under $path"
}

get_release_root() {
  if [ -n "$SOURCE_DIR" ]; then
    local source_abs
    source_abs="$(absolute_path "$SOURCE_DIR")"
    info "Using local source: $source_abs"
    if [ "$NO_PULL" -eq 0 ] && [ -d "$source_abs/.git" ]; then
      command -v git >/dev/null 2>&1 || fail "Git is required to update local source. Install Git or pass --no-pull."
      info "Updating local source with git fetch + pull --ff-only"
      git -C "$source_abs" fetch --prune >&2
      git -C "$source_abs" pull --ff-only >&2
    fi
    resolve_release_root "$source_abs"
    return 0
  fi

  command -v git >/dev/null 2>&1 || fail "Git is required for fetching hotfixes. Install Git or pass --source-dir."
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pai-hotfix-XXXXXX")"
  info "Fetching $REPO_URL ($BRANCH) into $TEMP_ROOT"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TEMP_ROOT" >&2
  resolve_release_root "$TEMP_ROOT"
}

manifest_entries() {
  local manifest="$1"
  local framework="$2"
  local tool
  tool="$(json_tool)"
  [ -n "$tool" ] || fail "Need python3, python, node, or bun to parse $manifest"

  if [ "$tool" = "python3" ] || [ "$tool" = "python" ]; then
    "$tool" - "$manifest" "$framework" <<'PY'
import json, sys
manifest, framework = sys.argv[1], sys.argv[2]
with open(manifest, "r", encoding="utf-8") as f:
    data = json.load(f)
for entry in data.get("entries", []):
    source = entry.get("source", "")
    target = ""
    if isinstance(entry.get("targets"), dict):
        target = entry["targets"].get(framework, "") or ""
    else:
        target = entry.get("target", "") or source
    if not target:
        continue
    transform = "1" if entry.get("transformInstructions") else "0"
    mirror = "1" if entry.get("mirrorToCodexAgentsSkills") else "0"
    print("\t".join([source, target, transform, mirror]))
PY
  else
    "$tool" -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const fw=process.argv[2]; for (const e of data.entries||[]) { const source=e.source||""; const target=e.targets ? (e.targets[fw]||"") : (e.target||source); if (!target) continue; console.log([source,target,e.transformInstructions?1:0,e.mirrorToCodexAgentsSkills?1:0].join("\t")); }' "$manifest" "$framework"
  fi
}

convert_instruction_content() {
  local source="$1"
  local framework="$2"
  local name="OpenCode"
  [ "$framework" = "codex" ] && name="Codex"

  sed \
    -e 's/\bCLAUDE\.md\b/AGENTS.md/g' \
    -e "s/Claude Code/$name/g" \
    -e 's#~/\.claude/PAI#$PAI_DIR#g' \
    -e 's#~/\.claude#$PAI_FRAMEWORK_DIR#g' \
    -e 's#\$PAI_FRAMEWORK_DIR/PAI#$PAI_DIR#g' \
    -e 's/^# AGENTS\.md.*$/# AGENTS.md/' \
    "$source"
}

copy_directory_contents() {
  local source="$1"
  local destination="$2"
  mkdir -p "$destination"
  (cd "$source" && tar cf - .) | (cd "$destination" && tar xf -)
}

# Decide what to do with an existing directory destination that may sit under a
# symlinked ancestor. absolute_path resolves symlinks (pwd -P), so when the
# resolved path differs from the literal path some ancestor is a symlink:
#   normal -> no symlinked ancestor, behave exactly as before
#   skip   -> destination already resolves to the managed source (dev symlink);
#             it is already current, do not delete/recopy through it
#   fail   -> destination resolves elsewhere through the symlinked ancestor;
#             refuse rather than recursively delete through it
reparse_target_action() {
  local target="$1"
  local source="$2"
  local real_target real_source
  real_target="$(absolute_path "$target")"
  if [ "$real_target" = "$target" ]; then
    printf 'normal\n'
    return 0
  fi
  real_source="$(absolute_path "$source")"
  if [ "$real_target" = "$real_source" ]; then
    printf 'skip\n'
  else
    printf 'fail\n'
  fi
}

# Replace a directory destination with the managed source without ever running
# rm -rf through a symlinked ancestor. Echoes "skipped" or "updated".
update_directory_target() {
  local target="$1"
  local source="$2"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    case "$(reparse_target_action "$target" "$source")" in
      skip)
        printf 'skipped\n'
        return 0
        ;;
      fail)
        fail "Refusing to recursively delete '$target' through a symlinked ancestor (resolves to '$(absolute_path "$target")', not the managed source '$source'). Replace the symlink before updating."
        ;;
    esac
    rm -rf -- "$target"
  fi
  copy_directory_contents "$source" "$target"
  printf 'updated\n'
}

backup_relative_path() {
  local install_root="$1"
  local path="$2"
  local root_full path_full
  root_full="$(absolute_path "$install_root")"
  path_full="$(absolute_path "$path")"
  case "$path_full" in
    "$root_full") basename "$path_full" ;;
    "$root_full"/*) printf '%s\n' "${path_full#"$root_full"/}" ;;
    *) printf '%s\n' "$path_full" | sed 's#[:/\\]\+#_#g' ;;
  esac
}

backup_existing() {
  local install_root="$1"
  local path="$2"
  local backup_root="$3"
  [ -e "$path" ] || return 0
  local relative backup_path
  relative="$(backup_relative_path "$install_root" "$path")"
  backup_path="$backup_root/$relative"
  mkdir -p "$(dirname "$backup_path")"
  cp -R "$path" "$backup_path"
  printf '%s\n' "$backup_path"
}

apply_entry() {
  local release_root="$1"
  local install_root="$2"
  local framework="$3"
  local backup_root="$4"
  local source_rel="$5"
  local target_rel="$6"
  local transform="$7"
  local mirror="$8"

  source_rel="$(printf '%s' "$source_rel" | tr '\\' '/')"
  target_rel="$(printf '%s' "$target_rel" | tr '\\' '/')"
  local source="$release_root/$source_rel"
  local target="$install_root/$target_rel"
  [ -e "$source" ] || fail "Manifest source missing: $source"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY RUN $source_rel -> $target_rel"
    return 0
  fi

  # Dev installs symlink managed dirs back into the source tree. When the
  # destination resolves through a symlinked ancestor to the very source being
  # copied it is already current: skip rather than copy a file/dir onto itself.
  if [ -e "$target" ] && [ "$(reparse_target_action "$target" "$source")" = "skip" ]; then
    success "$target (dev symlink resolves to managed source; left unchanged)"
    return 0
  fi

  local backup=""
  backup="$(backup_existing "$install_root" "$target" "$backup_root" || true)"
  mkdir -p "$(dirname "$target")"

  if [ -d "$source" ]; then
    if [ "$(update_directory_target "$target" "$source")" = "skipped" ]; then
      success "$target (dev symlink resolves to managed source; left unchanged)"
      return 0
    fi
  elif [ "$transform" = "1" ] && [ "$framework" != "claude" ]; then
    convert_instruction_content "$source" "$framework" > "$target"
  else
    cp "$source" "$target"
  fi

  if [ "$framework" = "codex" ] && [ "$mirror" = "1" ]; then
    case "$target_rel" in
      skills/*)
        local skill_name agents_root agents_target
        skill_name="$(basename "$target_rel")"
        agents_root="${AGENTS_SKILLS_ROOT:-$HOME/.agents/skills}"
        agents_target="$agents_root/$skill_name"
        backup_existing "$install_root" "$agents_target" "$backup_root" >/dev/null || true
        mkdir -p "$agents_root"
        update_directory_target "$agents_target" "$source" >/dev/null
        ;;
    esac
  fi

  if [ -n "$backup" ]; then
    success "$target (backup: $backup)"
  else
    success "$target (new file/dir)"
  fi
}

verify_install() {
  local install_root="$1"
  local framework="$2"
  local pai_dir="$install_root/PAI"
  local latest_path="$pai_dir/ALGORITHM/LATEST"
  if [ -f "$latest_path" ]; then
    local latest normalized algo_path
    latest="$(tr -d '[:space:]' < "$latest_path")"
    case "$latest" in v*) normalized="$latest" ;; *) normalized="v$latest" ;; esac
    algo_path="$pai_dir/ALGORITHM/$normalized.md"
    [ -f "$algo_path" ] || fail "Algorithm path does not resolve: $algo_path"
    success "Algorithm path resolves: $algo_path"
  fi

  local instruction="$install_root/AGENTS.md"
  [ "$framework" = "claude" ] && instruction="$install_root/CLAUDE.md"
  if [ -f "$instruction" ]; then
    if grep -Fq '$PAI_DIR/ALGORITHM/LATEST' "$instruction"; then
      success 'Instruction file points at $PAI_DIR/ALGORITHM/LATEST.'
    else
      warn "Instruction file does not mention \$PAI_DIR/ALGORITHM/LATEST: $instruction"
    fi
  fi
}

regenerate_codex_hooks_json() {
  local install_root="$1"
  local backup_root="$2"
  command -v bun >/dev/null 2>&1 || fail "Bun is required to regenerate Codex hooks.json after hotfix update."

  local script_path="$backup_root/regenerate-codex-hooks.ts"
  cat > "$script_path" <<'TS'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const dataDir = process.argv[3];
const configDir = process.argv[4];

if (!root || !dataDir || !configDir) {
  console.error("Usage: regenerate-codex-hooks.ts <install-root> <data-dir> <config-dir>");
  process.exit(1);
}

const { generateCodexHooksJson } = await import(pathToFileURL(join(root, "PAI", "PAI-Install", "engine", "config-gen.ts")).href);
const config = {
  framework: "codex",
  principalName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  aiName: "PAI",
  catchphrase: "",
  paiDir: root,
  configDir,
  dataDir,
};

await Bun.write(join(root, "hooks.json"), `${JSON.stringify(generateCodexHooksJson(config), null, 2)}\n`);
TS

  local data_dir
  data_dir="$(resolve_pai_data_dir)"
  local config_dir
  config_dir="$(resolve_pai_config_dir)"
  (cd "$install_root" && bun "$script_path" "$install_root" "$data_dir" "$config_dir")
  success "Regenerated Codex hooks.json from installed generator."
}

regenerate_opencode_native_artifacts() {
  local install_root="$1"
  local backup_root="$2"
  command -v bun >/dev/null 2>&1 || fail "Bun is required to regenerate OpenCode native artifacts after hotfix update."

  local pai_cli="$install_root/PAI/TOOLS/pai.ts"
  [ -f "$pai_cli" ] || fail "PAI CLI not found for OpenCode native regeneration: $pai_cli"

  backup_existing "$install_root" "$install_root/opencode.json" "$backup_root" >/dev/null || true
  backup_existing "$install_root" "$install_root/agents" "$backup_root" >/dev/null || true
  backup_existing "$install_root" "$install_root/commands" "$backup_root" >/dev/null || true

  local data_dir
  data_dir="$(resolve_pai_data_dir)"
  local config_dir
  config_dir="$(resolve_pai_config_dir)"
  (
    cd "$install_root"
    HOME="$HOME" \
    USERPROFILE="${USERPROFILE:-$HOME}" \
    OPENCODE_CONFIG_DIR="$install_root" \
    PAI_DATA_DIR="$data_dir" \
    PAI_CONFIG_DIR="$config_dir" \
    PAI_FRAMEWORK_DIR="$install_root" \
    PAI_FRAMEWORK="opencode" \
    PAI_SKIP_USER_ENV_UPDATE="1" \
    bun "$pai_cli" framework switch opencode
  )
  success "Regenerated OpenCode opencode.json, agents, and commands from installed PAI CLI."
}

printf '\nPAI | Installed Hotfix Updater\n\n'

target="$(resolve_target)"
target_framework="$(printf '%s' "$target" | awk -F '\t' 'NR==1 {print $1}')"
target_root="$(printf '%s' "$target" | awk -F '\t' 'NR==1 {print $2}')"
info "Framework: $target_framework"
info "Install root: $target_root"

release_root="$(get_release_root)"
info "Release root: $release_root"

manifest_file="${MANIFEST_PATH:-$release_root/hotfix-manifest.json}"
manifest_file="$(absolute_path "$manifest_file")"
[ -f "$manifest_file" ] || fail "Manifest not found: $manifest_file"
info "Manifest: $manifest_file"

stamp="$(date -u +%Y%m%d-%H%M%S)"
backup_root="$HOME/.pai/BACKUPS/hotfix-$stamp"
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$backup_root"
  info "Backups: $backup_root"
fi

while IFS=$'\t' read -r source_rel target_rel transform mirror; do
  [ -n "$source_rel" ] || continue
  apply_entry "$release_root" "$target_root" "$target_framework" "$backup_root" "$source_rel" "$target_rel" "$transform" "$mirror"
done < <(manifest_entries "$manifest_file" "$target_framework")

if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$target_framework" = "codex" ]; then
    regenerate_codex_hooks_json "$target_root" "$backup_root"
  elif [ "$target_framework" = "opencode" ]; then
    regenerate_opencode_native_artifacts "$target_root" "$backup_root"
  fi
  verify_install "$target_root" "$target_framework"
  success "Hotfix update complete. Restart the agent session so instructions reload."
else
  info "Dry run complete. No files changed."
fi
