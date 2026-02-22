#!/usr/bin/env bash
# GPU Toggle - one-time setup. Run once as root:
#   sudo bash setup.sh
#
# Installs:
#   /usr/local/bin/gpu-toggle-helper  — privileged modprobe wrapper
#   /etc/sudoers.d/gpu-toggle         — passwordless sudo for that helper
#   ~/.local/share/gnome-shell/extensions/gpu-toggle@local/

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Run with sudo:  sudo bash setup.sh" >&2
    exit 1
fi

TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
if [ -z "${TARGET_HOME}" ]; then
    echo "ERROR: Could not resolve home directory for user '${TARGET_USER}'" >&2
    exit 1
fi
EXTENSION_SRC="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DEST="${TARGET_HOME}/.local/share/gnome-shell/extensions/gpu-toggle@local"
ENV_DIR="${TARGET_HOME}/.config/environment.d"
ENV_FILE="${ENV_DIR}/90-gpu-toggle-intel-gnome.conf"
HELPER="/usr/local/bin/gpu-toggle-helper"
SUDOERS="/etc/sudoers.d/gpu-toggle"
COMPUTE_ONLY_MODPROBE="/etc/modprobe.d/gpu-toggle-compute-only.conf"
NVIDIA_KMS_OVERRIDE="/etc/modprobe.d/gpu-toggle-nvidia-kms.conf"

echo "==> Installing helper script at ${HELPER}"
cat > "${HELPER}" <<'HELPER_SCRIPT'
#!/usr/bin/env bash
# gpu-toggle-helper: privileged modprobe wrapper for the GPU Toggle GNOME extension.
# Run via: sudo gpu-toggle-helper {load|unload}
set -euo pipefail

MODPROBE="$(command -v modprobe)"

# When prime-select is set to intel, it writes:
#   alias nvidia off
#   alias nvidia-drm off
#   alias nvidia-modeset off
# into /usr/lib/modprobe.d/blacklist-nvidia.conf
# This makes "modprobe nvidia" silently become "modprobe off" and fail.
# Fix: temporarily move the file aside while loading modules.
PRIME_BLACKLIST="/usr/lib/modprobe.d/blacklist-nvidia.conf"
PRIME_BLACKLIST_BAK="/tmp/blacklist-nvidia-prime.bak"

load_modules() {
    if [ -f "$PRIME_BLACKLIST" ]; then
        mv "$PRIME_BLACKLIST" "$PRIME_BLACKLIST_BAK"
        # Always restore on exit, even if interrupted
        trap 'mv "$PRIME_BLACKLIST_BAK" "$PRIME_BLACKLIST" 2>/dev/null || true' EXIT
    fi

    # Load only the compute modules — nvidia + nvidia_uvm is all CUDA/nvidia-smi needs.
    # nvidia_modeset and nvidia_drm are for display/render offload; loading them causes
    # gnome-shell (mutter) to open the DRM device and hold it, making unload impossible
    # while logged in.
    "$MODPROBE" nvidia     || true
    "$MODPROBE" nvidia_uvm || true
}

unload_modules() {
    # NVIDIA daemons can hold open FDs to /dev/nvidia*.
    systemctl stop nvidia-persistenced 2>/dev/null || true
    systemctl stop nvidia-powerd 2>/dev/null || true
    systemctl stop nvidia-fabricmanager 2>/dev/null || true

    # Best-effort: terminate any remaining users of NVIDIA device nodes.
    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -t /dev/nvidia* 2>/dev/null | sort -u || true)"
        if [ -n "${pids}" ]; then
            kill ${pids} 2>/dev/null || true
            sleep 1
            kill -9 ${pids} 2>/dev/null || true
        fi
    fi

    # Use rmmod instead of modprobe -r because modprobe.d has:
    #   alias nvidia-drm off
    # which makes "modprobe -r nvidia_drm" silently become "modprobe -r off",
    # return 0, and leave nvidia_drm fully loaded.
    # rmmod bypasses modprobe.d aliases and talks directly to the kernel.
    RMMOD="$(command -v rmmod)"

    # If nvidia_drm is still loaded (e.g. old full-load state), remove it first.
    # It will fail here if gnome-shell holds the DRM device — which is the correct
    # error to surface rather than silently leaving it loaded.
    if grep -q "^nvidia_drm " /proc/modules 2>/dev/null; then
        "$RMMOD" nvidia_drm
    fi
    "$RMMOD" nvidia_modeset 2>/dev/null || true
    "$RMMOD" nvidia_uvm     2>/dev/null || true
    # nvidia base must come last; fail loudly if anything still depends on it.
    "$RMMOD" nvidia
}

case "${1:-}" in
    load)   load_modules   ;;
    unload) unload_modules ;;
    *)
        echo "Usage: gpu-toggle-helper {load|unload}" >&2
        exit 1
        ;;
esac
HELPER_SCRIPT
chmod 0755 "${HELPER}"

echo "==> Installing sudoers rule at ${SUDOERS}"
cat > "${SUDOERS}" <<SUDOERS_RULE
# GPU Toggle: allow ${TARGET_USER} to run the helper without a password prompt
${TARGET_USER} ALL=(root) NOPASSWD: ${HELPER}
SUDOERS_RULE
chmod 0440 "${SUDOERS}"
visudo -c -f "${SUDOERS}" || {
    echo "ERROR: sudoers syntax check failed — removing ${SUDOERS}" >&2
    rm "${SUDOERS}"
    exit 1
}

echo "==> Installing compute-only modprobe policy at ${COMPUTE_ONLY_MODPROBE}"
cat > "${COMPUTE_ONLY_MODPROBE}" <<'MODPROBE_EOF'
# GPU Toggle compute-only policy:
# keep desktop stack on Intel and avoid nvidia_drm/modeset auto-load.
blacklist nvidia_drm
blacklist nvidia_modeset
# Strong block (covers softdep/autoload paths that bypass plain blacklist on some systems)
install nvidia_drm /bin/false
install nvidia_modeset /bin/false
MODPROBE_EOF
chmod 0644 "${COMPUTE_ONLY_MODPROBE}"

echo "==> Installing NVIDIA KMS override at ${NVIDIA_KMS_OVERRIDE}"
cat > "${NVIDIA_KMS_OVERRIDE}" <<'KMS_EOF'
# GPU Toggle: keep NVIDIA DRM KMS disabled so GNOME stays on Intel stack.
options nvidia-drm modeset=0 fbdev=0
KMS_EOF
chmod 0644 "${NVIDIA_KMS_OVERRIDE}"

if command -v update-initramfs >/dev/null 2>&1; then
    echo "==> Rebuilding initramfs so compute-only policy applies from early boot"
    update-initramfs -u
fi

echo "==> Installing extension files to ${EXTENSION_DEST}"
mkdir -p "${EXTENSION_DEST}"
cp "${EXTENSION_SRC}/extension.js"   "${EXTENSION_DEST}/"
cp "${EXTENSION_SRC}/stylesheet.css" "${EXTENSION_DEST}/"
cp "${EXTENSION_SRC}/metadata.json"  "${EXTENSION_DEST}/"
chown -R "${TARGET_USER}:${TARGET_USER}" "${EXTENSION_DEST}"

echo "==> Writing Intel-first session defaults at ${ENV_FILE}"
mkdir -p "${ENV_DIR}"
cat > "${ENV_FILE}" <<'ENVEOF'
# GPU Toggle defaults:
# Keep GNOME Shell / desktop GL stack on Mesa/Intel by default so NVIDIA can
# be loaded for compute and unloaded again without session logout.
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
__GLX_VENDOR_LIBRARY_NAME=mesa
DRI_PRIME=0
ENVEOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${ENV_DIR}"

echo ""
echo "Done! GPU Toggle configured for user '${TARGET_USER}'."
echo "Reboot once to apply compute-only modprobe policy cleanly."
echo "After reboot, ON/OFF should work without session logout in normal use."
