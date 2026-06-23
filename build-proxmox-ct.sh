#!/usr/bin/env bash
# shellcheck shell=bash
# =============================================================================
# build-proxmox-ct.sh  –  Build a Proxmox LXC rootfs from WSL2 (no lxc-start)
#
# Run this from your project root (where server.py, lib/, etc. live).
#
# Usage:
#   sudo bash build-proxmox-ct.sh [TARGETARCH] [OUTPUT_NAME]
#
# Examples:
#   sudo bash build-proxmox-ct.sh amd64 feedBack-ct
#   sudo bash build-proxmox-ct.sh arm64 feedBack-ct
#
# The resulting container ships empty; mount or copy your .sloppak /
# loose-folder library into /dlc inside the CT after import.
#
# Environment variables:
#   SKIP_HASH_CHECK=1   Bypass SHA256 verification — for unpinned hashes OR
#                       to override mismatches when an upstream artifact rolls.
#                       Use with caution.
#   KEEP_BUILD_DIR=1    Retain ${BUILD_BASE} after a successful build
#   FORCE_REBUILD=1     Delete an existing rootfs without prompting (for CI)
#
# Prerequisites (install in WSL):
#   sudo apt install debootstrap systemd-container tar zstd curl unzip git
#
# On Proxmox, after transfer:
#   pct restore <VMID> feedBack-ct.tar.zst --storage local-lvm --rootfs 8 --unprivileged 1
# =============================================================================

set -euo pipefail

TARGETARCH="${1:-amd64}"
OUTPUT_NAME="${2:-feedBack-ct}"

# OUTPUT_NAME is a positional arg that flows into BUILD_BASE (interpolated into
# `mkdir -p` / `rm -rf` paths) and into the final tarball name. Reject anything
# outside a safe filename charset so an input like `../../etc` can't escape
# /tmp or shape the tarball path.
if [[ ! "$OUTPUT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[ERROR] OUTPUT_NAME must match ^[A-Za-z0-9._-]+\$ (got: '${OUTPUT_NAME}')" >&2
  exit 1
fi

# debootstrap requires a real Linux filesystem (ext4/tmpfs/etc.) — it creates
# device nodes that NTFS/FUSE mounts (/mnt/c, /mnt/d …) cannot represent.
# We default the build dir to /tmp (a Linux fs on every WSL2 setup we've
# seen, even when /tmp isn't strictly tmpfs) and copy the final tarball back.
# Namespace BUILD_BASE by OUTPUT_NAME + TARGETARCH so concurrent invocations
# (or stale leftovers from a prior build of a different artifact) don't
# collide on /tmp/proxmox-ct-build/rootfs. BUILD_BASE can still be overridden
# via the environment for users who want a known, reusable path.
BUILD_BASE="${BUILD_BASE:-/tmp/proxmox-ct-build-${OUTPUT_NAME}-${TARGETARCH}}"
# Safety net: BUILD_BASE feeds rm -rf in the cleanup trap, the rebuild flow,
# and (indirectly) the rootfs build. Refuse obviously dangerous values up
# front so a stray BUILD_BASE=/ or BUILD_BASE='' can never `rm -rf` the host.
case "$BUILD_BASE" in
  ""|/|//|/.*|.|./*|../*) echo "[ERROR] Refusing dangerous BUILD_BASE='${BUILD_BASE}'." >&2; exit 1 ;;
esac
if [[ "${BUILD_BASE}" != /* ]]; then
  echo "[ERROR] BUILD_BASE must be an absolute path (got: '${BUILD_BASE}')." >&2
  exit 1
fi

# Normalize so that things like /tmp/../etc resolve against the real prefix
# check below — without this, a path-traversal payload would slip past the
# /tmp/* match and the cleanup branches could rm-rf an unintended host path.
BUILD_BASE=$(realpath -m -- "$BUILD_BASE")
ROOTFS="${BUILD_BASE}/rootfs"

if (( ${#BUILD_BASE} < 6 )); then
  echo "[ERROR] BUILD_BASE='${BUILD_BASE}' is too short — refusing for safety." >&2
  exit 1
fi
if [[ "${BUILD_BASE}" != /tmp/* && "${I_KNOW_WHAT_IM_DOING:-0}" != "1" ]]; then
  echo "[ERROR] BUILD_BASE='${BUILD_BASE}' resolves outside /tmp." >&2
  echo "        Re-run with I_KNOW_WHAT_IM_DOING=1 to use a non-/tmp path." >&2
  exit 1
fi

mkdir -p "$BUILD_BASE"

# vgmstream tag and the immutable commit it MUST resolve to. A tag is a
# movable Git ref upstream — pinning the expected SHA and verifying after
# clone catches a re-tag without losing the shallow-clone optimisation.
VGMSTREAM_REF="r2083"
VGMSTREAM_COMMIT="57df2e179d929532094f4e4dd42ce5395514622b"
VGMSTREAM_REPO="https://github.com/vgmstream/vgmstream.git"
# Static ffmpeg binaries from BtbN/FFmpeg-Builds (GPL, 7.1 series).
# To bump: pick a new autobuild-* tag from
#   https://github.com/BtbN/FFmpeg-Builds/releases
# download the two linux gpl-7.1 tarballs, re-run
#   sha256sum ffmpeg-*-linux{64,arm64}-gpl-7.1.tar.xz
# and update FFMPEG_RELEASE + both builds + hashes below.
FFMPEG_RELEASE="autobuild-2026-06-01-15-02"
FFMPEG_BUILD_AMD64="ffmpeg-n7.1.4-7-gadcf20da26-linux64-gpl-7.1.tar.xz"
FFMPEG_BUILD_ARM64="ffmpeg-n7.1.4-7-gadcf20da26-linuxarm64-gpl-7.1.tar.xz"
FFMPEG_SHA256_AMD64=afde55344990650c117fbb7cb36b38d2ab6790b06beb06a9c43a9300c9ce277a
FFMPEG_SHA256_ARM64=03c8a7d9a7cf48d017a22a7c31acfdc8e76c5cb193923f883b0338c7baf0bd28

APP_DIR="/app"
VENV_DIR="/opt/app-venv"
PIP_VERSION="26.1.1"
DLC_DIR="/dlc"
CONFIG_DIR="/config"
SVC_USER="feedBack"

# Coloured logging
info() { echo -e "\033[1;34m[INFO]\033[0m  $*"; }
ok()   { echo -e "\033[1;32m[OK]\033[0m    $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m  $*"; }
die()  { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 && -d "${BUILD_BASE:-}" ]]; then
    warn "Build failed (exit $rc). Partial rootfs left at ${BUILD_BASE} for inspection."
    # Use printf directly: warn() pipes through `echo -e`, which would
    # re-interpret the backslash escapes that `printf %q` emits and
    # silently break the suggested cleanup command.
    printf "\033[1;33m[WARN]\033[0m  Run: sudo rm -rf %q\n" "${BUILD_BASE}"
  elif [[ $rc -eq 0 && -d "${BUILD_BASE:-}" && "${KEEP_BUILD_DIR:-0}" != "1" ]]; then
    info "Removing build directory ${BUILD_BASE} (set KEEP_BUILD_DIR=1 to retain)."
    rm -rf "${BUILD_BASE}"
  fi
}
trap cleanup EXIT

# Verify a downloaded file against a pinned SHA256 hash.
# Skips verification when the expected hash is empty (not yet pinned).
verify_sha256() {
  local file="$1" expected="$2" label="${3:-$1}"
  if [[ -z "$expected" ]]; then
    if [[ "${SKIP_HASH_CHECK:-0}" != "1" ]]; then
      die "No SHA256 pinned for ${label}. Pin the hash or set SKIP_HASH_CHECK=1 to proceed."
    fi
    warn "No SHA256 pinned for ${label} — skipping verification (SKIP_HASH_CHECK=1)."
    return 0
  fi
  local actual
  actual=$(sha256sum "$file" | awk '{print $1}')
  if [[ "$actual" != "$expected" ]]; then
    if [[ "${SKIP_HASH_CHECK:-0}" == "1" ]]; then
      warn "SHA256 mismatch for ${label} (expected ${expected}, got ${actual}) — continuing because SKIP_HASH_CHECK=1."
      return 0
    fi
    die "SHA256 mismatch for ${label}:\n" \
        "       expected: ${expected}\n" \
        "       got:      ${actual}\n" \
        "       Refresh the pinned hash, or set SKIP_HASH_CHECK=1 to bypass."
  fi
  ok "SHA256 verified for ${label}."
}

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"

case "$TARGETARCH" in
  arm64) RID="linux-arm64" ; DEBIAN_ARCH="arm64" ;;
  amd64) RID="linux-x64"   ; DEBIAN_ARCH="amd64" ;;
  *)     die "Unsupported TARGETARCH: ${TARGETARCH}. Expected: amd64 | arm64" ;;
esac

# arm64 cross-builds require qemu-user-static + a registered binfmt handler.
# Checking the binary alone isn't enough — without a registered+enabled handler
# debootstrap/nspawn fail later with "exec format error" after significant
# wasted setup time.
if [[ "$TARGETARCH" == "arm64" && "$(uname -m)" != "aarch64" ]]; then
  if ! command -v qemu-aarch64-static &>/dev/null; then
    die "arm64 builds on a non-arm64 host require qemu-user-static.\n" \
        "       Install with: sudo apt install qemu-user-static binfmt-support\n" \
        "       Then re-run this script."
  fi
  binfmt_reg=""
  for f in /proc/sys/fs/binfmt_misc/qemu-aarch64 \
           /proc/sys/fs/binfmt_misc/qemu-aarch64-static; do
    [[ -f "$f" ]] && grep -q '^enabled' "$f" 2>/dev/null && { binfmt_reg="$f"; break; }
  done
  if [[ -z "$binfmt_reg" ]]; then
    die "arm64 binfmt handler not registered or not enabled.\n" \
        "       Register with: sudo apt install qemu-user-static binfmt-support\n" \
        "       Or:           docker run --rm --privileged multiarch/qemu-user-static --reset -p yes\n" \
        "       Then verify:  grep ^enabled /proc/sys/fs/binfmt_misc/qemu-aarch64*"
  fi
fi

# Confirm required tools
for cmd in debootstrap systemd-nspawn curl unzip git tar zstd; do
  command -v "$cmd" &>/dev/null || die "'$cmd' not found. Run: sudo apt install debootstrap systemd-container curl unzip git tar zstd"
done

# =============================================================================
# Pre-flight: verify the pinned BtbN FFmpeg release still exists
# =============================================================================
# BtbN only keeps ~10 days of autobuilds. A stale FFMPEG_RELEASE means
# the build will 404 deep into step 5b after significant setup work.
# Fail fast with actionable instructions instead.
info "Checking ffmpeg release availability …"
case "$TARGETARCH" in
  arm64) _preflight_tarball="${FFMPEG_BUILD_ARM64}" ;;
  amd64) _preflight_tarball="${FFMPEG_BUILD_AMD64}" ;;
esac
_preflight_url="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${_preflight_tarball}"
_http_code=$(curl -sL -o /dev/null -w '%{http_code}' --head "${_preflight_url}" || true)
if [[ ! "$_http_code" =~ ^2[0-9]{2}$ ]]; then
  die "Pinned ffmpeg release is no longer available (HTTP ${_http_code}).

       URL: ${_preflight_url}

       BtbN/FFmpeg-Builds only keeps ~10 days of autobuilds.
       To fix, update these variables in build-proxmox-ct.sh:

         1. Pick a current release tag from:
            https://github.com/BtbN/FFmpeg-Builds/releases

         2. Update FFMPEG_RELEASE to the new tag
            (e.g. autobuild-YYYY-MM-DD-HH-MM)

         3. Update FFMPEG_BUILD_AMD64 and FFMPEG_BUILD_ARM64
            to the new *-linux64-gpl-7.1.tar.xz and
            *-linuxarm64-gpl-7.1.tar.xz filenames

         4. Update FFMPEG_SHA256_AMD64 and FFMPEG_SHA256_ARM64
            from the checksums.sha256 file in that release

       Also update the same ARGs in Dockerfile"
fi
ok "ffmpeg release verified (HTTP ${_http_code})."

# =============================================================================
# Helper: run a command inside the rootfs via systemd-nspawn
# --quiet suppresses nspawn chatter so apt/cmake output is the only
# thing we see during the build. The host's /etc/resolv.conf is
# bind-mounted read-only so DNS works inside nspawn.
# =============================================================================
r() {
  systemd-nspawn \
    --quiet \
    --directory="$ROOTFS" \
    --bind-ro=/etc/resolv.conf:/etc/resolv.conf \
    -- bash -c "set -e; $1"
}

# =============================================================================
# 1. Bootstrap a minimal Debian Trixie rootfs
# =============================================================================
info "Bootstrapping Debian Trixie (${DEBIAN_ARCH}) rootfs at ${ROOTFS} …"
if [[ -d "$ROOTFS" ]]; then
  if [[ "${FORCE_REBUILD:-0}" == "1" ]]; then
    info "FORCE_REBUILD=1 — removing existing rootfs at ${ROOTFS}."
    rm -rf "$ROOTFS" || die "Failed to remove existing rootfs at ${ROOTFS}."
  elif [[ -t 0 ]]; then
    warn "Existing rootfs found at ${ROOTFS} – remove it to rebuild from scratch."
    read -rp "    Delete and rebuild? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      rm -rf "$ROOTFS" || die "Failed to remove existing rootfs at ${ROOTFS}."
    else
      die "Aborting."
    fi
  else
    die "Existing rootfs at ${ROOTFS}; rerun with FORCE_REBUILD=1 to overwrite."
  fi
fi

debootstrap \
  --arch="$DEBIAN_ARCH" \
  --include=ca-certificates,curl,gnupg \
  trixie \
  "$ROOTFS" \
  https://deb.debian.org/debian

ok "Bootstrap complete."

# DNS during the build is supplied by the host's /etc/resolv.conf, which
# r() bind-mounts read-only into nspawn. The rootfs's own /etc/resolv.conf
# gets replaced with a systemd-resolved stub symlink in step 10(d).

# =============================================================================
# 2. System packages  (mirrors Stage 2 apt block)
# =============================================================================
info "Installing system packages …"
# systemd-sysv + systemd-resolved are explicit because the final container
# enables systemd-networkd/systemd-resolved units in step 10 and rewrites
# /etc/resolv.conf to the resolved stub — a minimal debootstrap does not
# guarantee these binaries on its own, which would yield broken DNS in the
# imported CT.
#
# NOTE: ffmpeg is NOT installed via apt — a static binary is copied in
# step 5b instead, avoiding the huge codec + TLS dependency tree.
# vgmstream-cli is built from source in step 5, needing runtime libs:
# libmpg123-0, libvorbisfile3, libspeex1, libopus0.
#
# Node.js: Debian Trixie ships Node 20 by default. We use extrepo to enable
# the official NodeSource Node 22.x repository for LTS support.
r "apt-get update -qq \
    && apt-get -y upgrade \
    && apt-get install -y --no-install-recommends \
    systemd-sysv systemd-resolved \
    python3 python3-pip python3-venv \
    fluidsynth \
    fluid-soundfont-gm \
    libsndfile1 \
    libmpg123-0 \
    libvorbisfile3 \
    libspeex1 \
    libopus0 \
    libstdc++6 \
    libgcc-s1 \
    extrepo \
    && apt-get clean && rm -rf /var/lib/apt/lists/*"
ok "System packages installed."

info "Enabling Node.js 22.x repository via extrepo …"
r "extrepo enable node_22.x \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*"
ok "Node.js 22.x installed."

# Build-time dependencies for compiling vgmstream-cli from source (step 5).
# Purged after the build in step 5c to keep the rootfs lean.
info "Installing vgmstream build dependencies (temporary) …"
# `git` intentionally absent — vgmstream is cloned host-side and the build
# itself uses cmake only, so the container never invokes git. Adding it back
# would pull in libcurl/libexpat unnecessarily.
r "apt-get update -qq && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config yasm \
    libmpg123-dev libvorbis-dev libspeex-dev libopus-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*"
ok "Build dependencies installed."

# =============================================================================
# 5. Build vgmstream-cli from source (mirrors Dockerfile stage 1b)
# =============================================================================
info "Building vgmstream-cli from source (${VGMSTREAM_REF}) …"
# Clone into /root/ — systemd-nspawn mounts a private tmpfs over /tmp,
# hiding anything placed at ${ROOTFS}/tmp/ by the host.
rm -rf "${ROOTFS}/root/vgmstream"
git clone --depth 1 --branch "${VGMSTREAM_REF}" "${VGMSTREAM_REPO}" "${ROOTFS}/root/vgmstream"
# Verify the tag still points at the pinned commit — a re-tag upstream
# would otherwise silently change what we ship.
_vgmstream_head=$(git -C "${ROOTFS}/root/vgmstream" rev-parse HEAD)
if [[ "${_vgmstream_head}" != "${VGMSTREAM_COMMIT}" ]]; then
  die "vgmstream tag ${VGMSTREAM_REF} resolves to ${_vgmstream_head}, expected ${VGMSTREAM_COMMIT}. Tag may have moved upstream — verify and update VGMSTREAM_COMMIT."
fi

r "cmake -S /root/vgmstream -B /root/vgmstream/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_V123=OFF \
        -DBUILD_AUDACIOUS=OFF \
        -DBUILD_SHARED_LIBS=OFF \
        -DUSE_FFMPEG=OFF \
    && cmake --build /root/vgmstream/build --config Release --target vgmstream_cli -j\$(nproc) \
    && cp /root/vgmstream/build/cli/vgmstream-cli /usr/local/bin/vgmstream-cli \
    && chmod +x /usr/local/bin/vgmstream-cli"
rm -rf "${ROOTFS}/root/vgmstream"
ok "vgmstream-cli built."

# =============================================================================
# 5b. Static ffmpeg (mirrors Dockerfile stage 1c — BtbN GPL build)
# =============================================================================
info "Installing static ffmpeg …"
case "$TARGETARCH" in
  arm64) FFMPEG_TARBALL="${FFMPEG_BUILD_ARM64}"; FFMPEG_SHA256="${FFMPEG_SHA256_ARM64}" ;;
  amd64) FFMPEG_TARBALL="${FFMPEG_BUILD_AMD64}"; FFMPEG_SHA256="${FFMPEG_SHA256_AMD64}" ;;
esac

curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_TARBALL}" \
    -o "${BUILD_BASE}/ffmpeg.tar.xz"
verify_sha256 "${BUILD_BASE}/ffmpeg.tar.xz" "${FFMPEG_SHA256}" "ffmpeg-static (${TARGETARCH})"

mkdir -p "${BUILD_BASE}/ffmpeg-extract"
tar -xJf "${BUILD_BASE}/ffmpeg.tar.xz" -C "${BUILD_BASE}/ffmpeg-extract" --strip-components=1
cp "${BUILD_BASE}/ffmpeg-extract/bin/ffmpeg"  "${ROOTFS}/usr/local/bin/ffmpeg"
cp "${BUILD_BASE}/ffmpeg-extract/bin/ffprobe" "${ROOTFS}/usr/local/bin/ffprobe"
chmod +x "${ROOTFS}/usr/local/bin/ffmpeg" "${ROOTFS}/usr/local/bin/ffprobe"

# GPL compliance — ship the license text AND a written offer pointing
# at where the corresponding source can be obtained, so redistributing
# the resulting CT template doesn't strand recipients without access to
# the source for the GPL-licensed binary. LICENSE.txt alone covers the
# license terms; the SOURCE file satisfies the "corresponding source"
# availability requirement of GPLv3 §6 / GPLv2 §3.
mkdir -p "${ROOTFS}/usr/share/doc/ffmpeg"
cp "${BUILD_BASE}/ffmpeg-extract/LICENSE.txt" "${ROOTFS}/usr/share/doc/ffmpeg/LICENSE.txt"
cat > "${ROOTFS}/usr/share/doc/ffmpeg/SOURCE" <<EOF
This ffmpeg/ffprobe binary is a static GPL build from the BtbN/FFmpeg-Builds
project (https://github.com/BtbN/FFmpeg-Builds). The exact build artefact
shipped here is:

  Release:  ${FFMPEG_RELEASE}
  Tarball:  ${FFMPEG_TARBALL}
  SHA-256:  ${FFMPEG_SHA256}

Corresponding source code (per GPL):
  - Build recipe + scripts: https://github.com/BtbN/FFmpeg-Builds/tree/${FFMPEG_RELEASE}
  - Upstream FFmpeg source: https://github.com/FFmpeg/FFmpeg (the FFmpeg
    commit baked into this build is identified by the n7.1.x version tag
    in the tarball filename, e.g. n7.1.4-5-ged860ef7d9 → upstream commit
    ed860ef7d9).

If either URL becomes unavailable, the maintainer of this CT template will
make the corresponding source available on request for at least three years,
per GPLv2 §3(b) / GPLv3 §6(b).
EOF

rm -rf "${BUILD_BASE}/ffmpeg-extract" "${BUILD_BASE}/ffmpeg.tar.xz"
ok "Static ffmpeg installed."

# =============================================================================
# 5c. Clean up build-time dependencies
# =============================================================================
info "Removing build-time dependencies …"
r "apt-get purge -y --auto-remove \
    build-essential cmake pkg-config yasm \
    libmpg123-dev libvorbis-dev libspeex-dev libopus-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*"
ok "Build dependencies removed."

# =============================================================================
# 5d. Tailwind CLI for runtime stylesheet regeneration
# =============================================================================
# When a plugin is installed into FEEDBACK_PLUGINS_DIR at runtime (or
# discovered there on startup), the server rebuilds static/tailwind.min.css
# so the plugin's classes are styled — the image-baked sheet only covers
# in-tree plugins (see lib/tailwind_rebuild.py). tailwindcss is installed
# globally so the rebuild runs offline, with no npx fetch at install time.
# nodejs + npm were installed in step 2 via apt.
info "Installing Tailwind CLI globally …"
r "npm install -g tailwindcss@3.4.19 \
    && npm cache clean --force"
ok "Tailwind CLI installed."

# =============================================================================
# 6. Python application
# =============================================================================
info "Setting up Python application …"
mkdir -p \
  "${ROOTFS}${APP_DIR}/lib" \
  "${ROOTFS}${APP_DIR}/static" \
  "${ROOTFS}${APP_DIR}/plugins"

for d in lib static plugins; do
  if [[ -d "$d" ]]; then
    cp -r "${d}/." "${ROOTFS}${APP_DIR}/${d}/"
    info "  Copied ${d}/"
  else
    # main.py imports logging_setup from lib/; server.py imports plugins.
    # Without these the rootfs boots and the service crashes immediately.
    if [[ "$d" == "lib" || "$d" == "plugins" ]]; then
      die "  '${d}/' not found — required for the service to import."
    fi
    warn "  Local '${d}/' not found – skipping."
  fi
done

for f in requirements.txt server.py VERSION main.py tailwind.config.js; do
  if [[ -f "$f" ]]; then
    cp "$f" "${ROOTFS}${APP_DIR}/"
    info "  Copied ${f}"
  else
    # main.py imports `server:app`, so without server.py the service unit
    # would boot but fail on first request — make it fail-fast at build.
    if [[ "$f" == "requirements.txt" || "$f" == "main.py" || "$f" == "server.py" ]]; then
      die "  '${f}' not found — required for the service to start."
    fi
    warn "  '${f}' not found – skipping."
  fi
done

info "Creating Python venv and installing dependencies …"
r "python3 -m venv ${VENV_DIR} \
    && ${VENV_DIR}/bin/pip install --no-cache-dir 'pip==${PIP_VERSION}' \
    && ${VENV_DIR}/bin/pip install --no-cache-dir -r ${APP_DIR}/requirements.txt"
ok "Python venv + dependencies installed."

# =============================================================================
# 6b. Build Tailwind stylesheet over the full plugin set
# =============================================================================
# The committed static/tailwind.min.css is generated against only the in-tree
# plugins. Rebuild it here after static/ + plugins/ are in place so the sheet
# covers whatever plugins are baked into the rootfs. Mirrors Dockerfile
# stage 1d. Runtime-installed plugins are handled by the server's rebuild.
info "Building Tailwind stylesheet …"
r "cd ${APP_DIR} \
    && tailwindcss \
        -c tailwind.config.js \
        -i static/_tailwind.src.css \
        -o static/tailwind.min.css \
        --minify"
ok "Tailwind stylesheet built."

# =============================================================================
# 7. Data directories + assets
# =============================================================================
info "Populating data directories …"
# The library folder (${DLC_DIR}) is created empty — mount or copy your
# .sloppak / loose-folder library into it after the CT is imported.
mkdir -p "${ROOTFS}${CONFIG_DIR}" "${ROOTFS}${DLC_DIR}"

if [[ -d "config" ]]; then
  cp -r config/. "${ROOTFS}${CONFIG_DIR}/"
  info "  Copied config/"
else
  warn "  config/ not found."
fi

# =============================================================================
# 8. Environment variables
# =============================================================================
info "Writing /etc/environment …"
cat > "${ROOTFS}/etc/environment" <<EOF
PATH=${VENV_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PYTHONPATH=${APP_DIR}/lib:${APP_DIR}
DLC_DIR=${DLC_DIR}
CONFIG_DIR=${CONFIG_DIR}
EOF

# =============================================================================
# 9. systemd service for uvicorn
# =============================================================================
info "Creating service user '${SVC_USER}' …"
r "useradd --system --home-dir ${APP_DIR} --shell /usr/sbin/nologin ${SVC_USER}"
ok "User '${SVC_USER}' created."

info "Installing feedBack-server.service …"
mkdir -p "${ROOTFS}/etc/systemd/system"
cat > "${ROOTFS}/etc/systemd/system/feedBack-server.service" <<EOF
[Unit]
Description=FeedBack uvicorn server
After=network.target

[Service]
User=${SVC_USER}
# Default port (8000) is non-privileged; uncomment the next line only if
# you set PORT<1024 in /etc/environment so the unit can bind it.
# AmbientCapabilities=CAP_NET_BIND_SERVICE
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/environment
ExecStart=${VENV_DIR}/bin/python3 main.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable by symlinking (avoids running systemctl inside nspawn)
mkdir -p "${ROOTFS}/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/feedBack-server.service \
       "${ROOTFS}/etc/systemd/system/multi-user.target.wants/feedBack-server.service"
ok "Service enabled."

# =============================================================================
# 10. Proxmox-specific tweaks
# =============================================================================
info "Applying Proxmox CT compatibility tweaks …"

# (a) Ensure a working /etc/hostname and /etc/hosts.
# Use OUTPUT_NAME (already validated to a safe filename charset) so the
# template's identity matches the artifact name. This is just a sane
# fallback — `pct restore --hostname …` (or the Proxmox UI) will overwrite
# /etc/hostname when the CT is created from this template.
DEFAULT_HOSTNAME="${OUTPUT_NAME//_/-}"  # underscores aren't valid in hostnames
echo "${DEFAULT_HOSTNAME}" > "${ROOTFS}/etc/hostname"
cat > "${ROOTFS}/etc/hosts" <<EOF
127.0.0.1   localhost
127.0.1.1   ${DEFAULT_HOSTNAME}
::1         localhost ip6-localhost ip6-loopback
EOF

# (b) Clear machine-id so Proxmox generates a fresh one on first boot
# A pre-filled machine-id can cause network/systemd conflicts across clones.
echo -n > "${ROOTFS}/etc/machine-id"
[[ -f "${ROOTFS}/var/lib/dbus/machine-id" ]] && echo -n > "${ROOTFS}/var/lib/dbus/machine-id"

# (c) DHCP networking via systemd-networkd (Proxmox expects this for unprivileged CTs)
mkdir -p "${ROOTFS}/etc/systemd/network"
cat > "${ROOTFS}/etc/systemd/network/20-eth0.network" <<EOF
[Match]
Name=eth0

[Network]
DHCP=yes
EOF

# Enable via symlinks on the host – systemctl inside nspawn needs a running
# init which WSL doesn't provide.

mkdir -p "${ROOTFS}/etc/systemd/system/multi-user.target.wants"
for svc in systemd-networkd systemd-resolved; do
  unit_src=""
  for d in /lib/systemd/system /usr/lib/systemd/system; do
    if [[ -e "${ROOTFS}${d}/${svc}.service" ]]; then
      unit_src="${d}/${svc}.service"
      break
    fi
  done
  if [[ -z "$unit_src" ]]; then
    die "${svc}.service unit not found in rootfs — DNS/networking would be broken in the imported CT."
  fi
  ln -sf "${unit_src}" "${ROOTFS}/etc/systemd/system/multi-user.target.wants/${svc}.service"
done

# (d) Ensure correct permissions on key dirs.
# -h preserves symlinks: a Python venv keeps /opt/app-venv/bin/python3 as a
# symlink to /usr/bin/python3, and a plain `chown -R` would chase it and
# rewrite the system interpreter's ownership inside the rootfs.
SVC_UID="$(r "id -u ${SVC_USER}" | tr -d '\r')"
SVC_GID="$(r "id -g ${SVC_USER}" | tr -d '\r')"
chown -hR "${SVC_UID}:${SVC_GID}" \
              "${ROOTFS}${APP_DIR}" "${ROOTFS}${CONFIG_DIR}" \
              "${ROOTFS}${DLC_DIR}" "${ROOTFS}${VENV_DIR}"

# (e) Fix resolv.conf to use the systemd-resolved stub. MUST run after the
# last r() invocation: r() bind-mounts the host /etc/resolv.conf onto the
# rootfs path, and systemd-nspawn follows symlinks when resolving the bind
# target — pointing /etc/resolv.conf at /run/systemd/resolve/stub-resolv.conf
# before that would make subsequent r() calls try to bind onto a path that
# doesn't exist during the build.
rm -f "${ROOTFS}/etc/resolv.conf"
ln -sf /run/systemd/resolve/stub-resolv.conf "${ROOTFS}/etc/resolv.conf"

ok "Proxmox tweaks applied."

# =============================================================================
# 11. Package as a Proxmox-importable .tar.zst
# =============================================================================
OUTPUT_FILE="${OUTPUT_NAME}.tar.zst"
info "Creating ${OUTPUT_FILE} …"

# Proxmox pct restore expects a plain rootfs tarball (no ./rootfs/ prefix).
tar \
  --numeric-owner \
  --xattrs \
  --acls \
  -C "$ROOTFS" \
  -c . \
  | zstd -T0 -9 > "$OUTPUT_FILE"

ok "Template ready: $(pwd)/${OUTPUT_FILE}  ($(du -sh "$OUTPUT_FILE" | cut -f1))"

# =============================================================================
# Done
# =============================================================================
cat <<DONE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Build complete!

  Transfer to Proxmox:
    scp ${OUTPUT_FILE} root@<proxmox-host>:/var/lib/vz/template/cache/

  Import on Proxmox (pick an unused VMID, e.g. 200):
    pct restore 200 /var/lib/vz/template/cache/${OUTPUT_FILE} \\
        --storage local-lvm \\
        --rootfs 8 \\
        --memory 2048 \\
        --cores 2 \\
        --net0 name=eth0,bridge=vmbr0,ip=dhcp \\
        --unprivileged 1 \\
        --start 1

  Then check the server:
    pct exec 200 -- systemctl status feedBack-server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DONE
