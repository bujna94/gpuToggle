const { St, Gio, GLib, GObject, Clutter } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const UUID = 'gpu-toggle@local';
const REFRESH_MS = 5000;
const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const GPU_HELPER = '/usr/local/bin/gpu-toggle-helper';

const GpuToggleIndicator = GObject.registerClass(
class GpuToggleIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'GPU Toggle');

        this._isBusy = false;
        this._refreshSourceId = 0;
        this._spinnerSourceId = 0;
        this._spinnerFrameIndex = 0;
        this._refreshInProgress = false;

        this._sudoPath    = GLib.find_program_in_path('sudo');
        this._pkexecPath  = GLib.find_program_in_path('pkexec');
        this._modprobePath = GLib.find_program_in_path('modprobe');
        this._nvidiaSmiPath = GLib.find_program_in_path('nvidia-smi');
        this._lsofPath    = GLib.find_program_in_path('lsof');

        this._state = {
            isOn: false,
            power: 'n/a',
            pstate: 'n/a',
            temp: 'n/a',
        };

        this._buildUi();
        this._startRefreshLoop();
        this._refreshStatus();
    }

    _buildUi() {
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._iconLabel = new St.Label({
            text: '◯',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'gpu-toggle-icon-off',
        });

        this._spinnerLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gpu-toggle-spinner',
            visible: false,
        });

        this._panelBox.add_child(this._iconLabel);
        this._panelBox.add_child(this._spinnerLabel);
        this.add_child(this._panelBox);

        this._statusItem = new PopupMenu.PopupMenuItem('Status: unknown', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._turnOnItem = new PopupMenu.PopupMenuItem('Turn GPU ON');
        this._turnOnItem.connect('activate', () => this._turnGpuOn());
        this.menu.addMenuItem(this._turnOnItem);

        this._turnOffItem = new PopupMenu.PopupMenuItem('Turn GPU OFF');
        this._turnOffItem.connect('activate', () => this._turnGpuOff());
        this.menu.addMenuItem(this._turnOffItem);
    }

    _startRefreshLoop() {
        this._refreshSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_MS,
            () => {
                this._refreshStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _startSpinner() {
        if (this._spinnerSourceId)
            GLib.Source.remove(this._spinnerSourceId);

        this._iconLabel.visible = false;
        this._spinnerLabel.visible = true;
        this._spinnerFrameIndex = 0;
        this._spinnerLabel.text = SPINNER_FRAMES[this._spinnerFrameIndex];

        this._spinnerSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            120,
            () => {
                this._spinnerFrameIndex = (this._spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
                this._spinnerLabel.text = SPINNER_FRAMES[this._spinnerFrameIndex];
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopSpinner() {
        if (this._spinnerSourceId) {
            GLib.Source.remove(this._spinnerSourceId);
            this._spinnerSourceId = 0;
        }
        this._spinnerLabel.text = '';
        this._spinnerLabel.visible = false;
        this._iconLabel.visible = true;
    }

    _setBusy(busy) {
        this._isBusy = busy;
        this._turnOnItem.setSensitive(!busy);
        this._turnOffItem.setSensitive(!busy);

        if (busy)
            this._startSpinner();
        else
            this._stopSpinner();
    }

    async _runCommand(argv) {
        return new Promise(resolve => {
            try {
                let proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        let [, stdout, stderr] = p.communicate_utf8_finish(res);
                        let status = p.get_exit_status();
                        resolve({
                            ok: status === 0,
                            status,
                            stdout: (stdout || '').trim(),
                            stderr: (stderr || '').trim(),
                        });
                    } catch (e) {
                        resolve({ ok: false, status: -1, stdout: '', stderr: e.message });
                    }
                });
            } catch (e) {
                resolve({ ok: false, status: -1, stdout: '', stderr: e.message });
            }
        });
    }

    // Run the privileged helper (load/unload).
    // Tries sudo -n first (no password if sudoers is configured via setup.sh).
    // Falls back to pkexec (polkit password dialog) if sudo can't do it silently.
    async _runHelper(action) {
        if (GLib.file_test(GPU_HELPER, GLib.FileTest.IS_EXECUTABLE) && this._sudoPath) {
            let result = await this._runCommand([this._sudoPath, '-n', GPU_HELPER, action]);
            let needsPassword = !result.ok && (
                result.stderr.includes('a password is required') ||
                result.stderr.includes('no tty present') ||
                result.stderr.includes('not allowed to run')
            );
            if (!needsPassword)
                return result;
        }

        // Fallback: pkexec + direct modprobe (will show polkit password dialog).
        // Run setup.sh once to avoid this prompt.
        if (!this._modprobePath)
            return { ok: false, stderr: 'modprobe not found in PATH' };

        if (!this._pkexecPath)
            return { ok: false, stderr: 'Neither sudo helper nor pkexec available. Run setup.sh.' };

        if (action === 'load')
            return this._runCommand([
                this._pkexecPath, this._modprobePath,
                'nvidia', 'nvidia_uvm',
            ]);

        if (action === 'unload')
            return this._runCommand([
                this._pkexecPath, this._modprobePath,
                '-r', 'nvidia_drm', 'nvidia_modeset', 'nvidia_uvm', 'nvidia',
            ]);

        return { ok: false, stderr: `Unknown action: ${action}` };
    }

    // Find processes currently using the NVIDIA GPU.
    // Returns array of human-readable strings, e.g. ["Xorg (display)", "python3 (compute)"].
    async _findGpuUsers() {
        let users = new Set();

        // Compute apps via nvidia-smi
        if (this._nvidiaSmiPath) {
            let r = await this._runCommand([
                this._nvidiaSmiPath,
                '--query-compute-apps=pid,process_name',
                '--format=csv,noheader',
            ]);
            if (r.ok && r.stdout.trim()) {
                r.stdout.split('\n').filter(l => l.trim()).forEach(line => {
                    let parts = line.split(',');
                    let name = (parts[1] || parts[0] || '').trim();
                    if (name) users.add(`${name} (compute)`);
                });
            }
        }

        // Processes with NVIDIA device files open (display server, etc.)
        if (this._lsofPath) {
            let nvDevs = [
                '/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-modeset',
            ].filter(p => GLib.file_test(p, GLib.FileTest.EXISTS));

            if (nvDevs.length > 0) {
                let r = await this._runCommand([this._lsofPath, '-F', 'cn', ...nvDevs]);
                if (r.ok && r.stdout.trim()) {
                    // lsof -F output: lines starting with 'c' = command name
                    r.stdout.split('\n').forEach(line => {
                        if (line.startsWith('c') && line.length > 1) {
                            let name = line.slice(1).trim();
                            if (name) users.add(name);
                        }
                    });
                }
            }
        }

        // DRM device users (handles display server case)
        if (this._lsofPath) {
            let drmDevs = this._getNvidiaDrmDevices();
            if (drmDevs.length > 0) {
                let r = await this._runCommand([this._lsofPath, '-F', 'cn', ...drmDevs]);
                if (r.ok && r.stdout.trim()) {
                    let lastName = null;
                    r.stdout.split('\n').forEach(line => {
                        if (line.startsWith('c') && line.length > 1) {
                            lastName = line.slice(1).trim();
                            return;
                        }
                        if (line.startsWith('n') && lastName)
                            users.add(`${lastName} (display/DRM)`);
                    });
                }
            }
        }

        // nvidia-persistenced daemon
        let persist = await this._runCommand(['pgrep', '-x', 'nvidia-persistenced']);
        if (persist.ok && persist.stdout.trim())
            users.add('nvidia-persistenced (daemon)');

        return [...users];
    }

    _getNvidiaDrmDevices() {
        // Map only cardN devices actually bound to nvidia_drm to avoid false positives.
        let devs = [];
        let seen = new Set();

        for (let i = 0; i < 16; i++) {
            let driverModule = `/sys/class/drm/card${i}/device/driver/module`;
            if (!GLib.file_test(driverModule, GLib.FileTest.EXISTS))
                continue;

            let target = null;
            try {
                target = GLib.file_read_link(driverModule);
            } catch (_e) {
                continue;
            }

            if (!target || !target.endsWith('/nvidia_drm'))
                continue;

            let card = `/dev/dri/card${i}`;
            let render = `/dev/dri/renderD${128 + i}`;
            if (GLib.file_test(card, GLib.FileTest.EXISTS) && !seen.has(card)) {
                seen.add(card);
                devs.push(card);
            }
            if (GLib.file_test(render, GLib.FileTest.EXISTS) && !seen.has(render)) {
                seen.add(render);
                devs.push(render);
            }
        }

        return devs;
    }

    _isModuleNotLoadedError(stderrText) {
        if (!stderrText) return false;
        // If any module reported "in use", that's a real error — don't suppress it.
        if (stderrText.toLowerCase().includes('is in use')) return false;
        return stderrText.includes('not currently loaded') ||
            (stderrText.includes('Module') && stderrText.includes('not found'));
    }

    _extractModuleInUse(stderrText) {
        if (!stderrText) return null;
        let match = stderrText.match(/Module\s+([A-Za-z0-9_]+)\s+is in use/i);
        return match ? match[1] : null;
    }

    _updateUi() {
        if (this._state.isOn) {
            this._iconLabel.text = '⚡';
            this._iconLabel.style_class = 'gpu-toggle-icon-on';
        } else {
            this._iconLabel.text = '◯';
            this._iconLabel.style_class = 'gpu-toggle-icon-off';
        }

        let onOff = this._state.isOn ? 'ON' : 'OFF';
        let { power, pstate, temp } = this._state;

        this._statusItem.label.text = `Status: ${onOff} | ${power}W | ${pstate} | ${temp}C`;
        let tooltip = `GPU: ${onOff} | Power: ${power}W | P-state: ${pstate} | Temp: ${temp}C`;

        if (typeof this.set_tooltip_text === 'function')
            this.set_tooltip_text(tooltip);
        else
            this.accessible_name = tooltip;
    }

    async _detectGpuOn() {
        // /dev/nvidia0 can remain as a stale node after unload; don't use it as ON signal.
        if (this._nvidiaSmiPath) {
            let result = await this._runCommand([this._nvidiaSmiPath, '-L']);
            if (result.ok)
                return true;
        }

        // Fallback: consider ON only if the base module is currently loaded.
        try {
            let [ok, contents] = GLib.file_get_contents('/proc/modules');
            if (!ok)
                return false;
            let text = imports.byteArray.toString(contents);
            return text.split('\n').some(line => line.startsWith('nvidia '));
        } catch (_e) {
            return false;
        }
    }

    async _queryGpuStats() {
        if (!this._nvidiaSmiPath)
            return { power: 'n/a', pstate: 'n/a', temp: 'n/a' };

        let result = await this._runCommand([
            this._nvidiaSmiPath,
            '--query-gpu=power.draw,power.limit,pstate,temperature.gpu',
            '--format=csv,noheader,nounits',
        ]);

        if (!result.ok || !result.stdout)
            return { power: 'n/a', pstate: 'n/a', temp: 'n/a' };

        let [powerRaw, limitRaw, pstateRaw, tempRaw] = result.stdout.split('\n')[0].trim().split(',').map(s => s.trim());
        let powerOut = powerRaw || 'n/a';
        let powerVal = Number.parseFloat(powerRaw);
        let limitVal = Number.parseFloat(limitRaw);
        let hasLimit = Number.isFinite(limitVal) && limitVal > 0;

        // Guard against known bogus telemetry spikes (e.g. 700W+ on an 80W cap system).
        if (!Number.isFinite(powerVal) || powerVal < 0)
            powerOut = 'n/a';
        else if (hasLimit && powerVal > (limitVal * 1.5))
            powerOut = 'n/a';
        else if (!hasLimit && powerVal > 200)
            powerOut = 'n/a';

        return {
            power: powerOut,
            pstate: pstateRaw || 'n/a',
            temp: tempRaw || 'n/a',
        };
    }

    async _refreshStatus(force = false) {
        if (this._refreshInProgress) return;
        if (this._isBusy && !force) return;

        this._refreshInProgress = true;
        try {
            let isOn = await this._detectGpuOn();
            let stats = { power: 'n/a', pstate: 'n/a', temp: 'n/a' };
            if (isOn)
                stats = await this._queryGpuStats();

            this._state.isOn = isOn;
            this._state.power = stats.power;
            this._state.pstate = stats.pstate;
            this._state.temp = stats.temp;
            this._updateUi();
        } finally {
            this._refreshInProgress = false;
        }
    }

    async _turnGpuOn() {
        if (this._isBusy) return;
        this._setBusy(true);
        try {
            let result = await this._runHelper('load');
            if (!result.ok) {
                // Some setups partially succeed (GPU becomes available) while helper exits non-zero.
                // Treat as success if nvidia-smi works after load attempt.
                let isOn = await this._detectGpuOn();
                if (!isOn)
                    throw new Error(result.stderr || 'modprobe load failed');
            }

            Main.notify('GPU Toggle', 'GPU enabled and ready.');
        } catch (e) {
            let msg = e.message || '';
            if (msg.includes("name='off'") || msg.includes('"off"'))
                msg = 'Blocked by prime-select intel (alias nvidia → off). Run setup.sh to fix.';
            Main.notify('GPU Toggle', `Failed to enable GPU: ${msg}`);
        } finally {
            this._setBusy(false);
            await this._refreshStatus(true);
        }
    }

    async _turnGpuOff() {
        if (this._isBusy) return;
        this._setBusy(true);

        try {
            // display_active can be true on systems where unload is still possible.
            // Treat this as a hint only; attempt unload first.
            let displayLikelyActive = false;
            if (this._nvidiaSmiPath) {
                let displayCheck = await this._runCommand([
                    this._nvidiaSmiPath,
                    '--query-gpu=display_active',
                    '--format=csv,noheader',
                ]);
                if (displayCheck.ok) {
                    let val = displayCheck.stdout.split('\n')[0].trim().toLowerCase();
                    displayLikelyActive = val.includes('enabled');
                }
            }

            // Attempt unload
            let result = await this._runHelper('unload');

            if (!result.ok && !this._isModuleNotLoadedError(result.stderr)) {
                // Identify exactly what is still using the GPU
                let users = await this._findGpuUsers();
                let msg = 'GPU busy — modules in use.';
                if (users.length > 0)
                    msg += ` Active: ${users.join(', ')}. Close them and retry.`;
                else {
                    let inUse = this._extractModuleInUse(result.stderr);
                    msg += inUse
                        ? ` ${inUse} is in use. Close NVIDIA users and retry.`
                        : ` (${result.stderr || 'unknown reason'})`;
                }
                if ((result.stderr || '').toLowerCase().includes('nvidia_drm') &&
                    (result.stderr || '').toLowerCase().includes('is in use')) {
                    msg += ' Apply compute-only policy with setup.sh, reboot once, then retry OFF.';
                }
                if (displayLikelyActive)
                    msg += ' NVIDIA display stack is active; if blocker is gnome-shell, log out/in before OFF.';
                Main.notify('GPU Toggle', msg);
                return;
            }

            Main.notify('GPU Toggle', 'GPU modules disabled.');
        } catch (e) {
            Main.notify('GPU Toggle', `Failed to disable GPU: ${e.message}`);
        } finally {
            this._setBusy(false);
            await this._refreshStatus(true);
        }
    }

    destroy() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        this._stopSpinner();
        super.destroy();
    }
});

class Extension {
    constructor() {
        this._indicator = null;
    }

    enable() {
        this._indicator = new GpuToggleIndicator();
        Main.panel.addToStatusArea(UUID, this._indicator, 0, 'right');
    }

    disable() {
        if (!this._indicator) return;
        this._indicator.destroy();
        this._indicator = null;
    }
}

function init() {
    return new Extension();
}
