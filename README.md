# GPU Toggle GNOME Extension (`gpu-toggle@local`)

GNOME Shell extension for Ubuntu 22.04 / GNOME 42.9 that adds a top-right panel indicator to control NVIDIA kernel module load/unload without reboot.

## Features

- Panel indicator with dynamic status:
  - Green lightning bolt (`⚡`) when GPU modules are ON and `nvidia-smi` works
  - Red hollow circle (`◯`) when GPU modules are OFF
- Tooltip and menu status with:
  - ON/OFF state
  - Power draw (W)
  - P-state
  - Temperature (C)
- Dropdown actions:
  - Turn GPU ON
  - Turn GPU OFF
- Auto-refresh every 5 seconds via `GLib.timeout_add`
- Async command execution via `Gio.Subprocess` (non-blocking UI)
- Spinner shown while toggling/actions are running
- Stale `/dev/nvidia0` handling: OFF state detection is based on `nvidia-smi` + module state (not node existence)

## Install

1. Run one-time setup as root:

```bash
sudo bash setup.sh
```

This installs:
- `/usr/local/bin/gpu-toggle-helper`
- `/etc/sudoers.d/gpu-toggle` (passwordless helper for your user)
- extension files in `~/.local/share/gnome-shell/extensions/gpu-toggle@local/`
- NVIDIA compute-only policy in `/etc/modprobe.d/`
- Intel-first desktop env defaults in `~/.config/environment.d/`

2. Enable extension:

```bash
gnome-extensions enable gpu-toggle@local
```

## GNOME 42 Restart

On GNOME 42 (Wayland), use log out / log in to reload shell extensions fully.

## Remove Extension

```bash
gnome-extensions disable gpu-toggle@local
rm -rf ~/.local/share/gnome-shell/extensions/gpu-toggle@local
```

## Notes

- GPU ON detection:
  - `nvidia-smi -L` exits successfully, or
  - `nvidia` kernel module is currently loaded
- GPU OFF uses privileged unload and reports exact blocking module/user when busy.

## Telemetry Tradeoff

This project is tuned for reliable ON/OFF without logout by keeping NVIDIA display DRM paths disabled (`nvidia_drm`/`nvidia_modeset` blocked). On some driver/hardware combinations, this can cause inaccurate `nvidia-smi` power telemetry (for example showing impossible values like `752W`).

Pragmatic rule:
- If ON/OFF reliability is your priority, keep compute-only policy enabled and treat power draw as best-effort telemetry.
- If exact `nvidia-smi` wattage is your priority, remove compute-only overrides and run full NVIDIA display stack (but OFF may become less reliable due to module-in-use locks).
