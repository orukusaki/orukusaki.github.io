import { WebDFU, dfuCommands } from "dfu";

const DEFAULT_CHANNELS = [
    {
        id: "stable",
        label: "Latest stable (1.0.0)",
        url: "./firmware/latest.bin",
    },
    {
        id: "beta",
        label: "Latest beta (1.1.0-beta)",
        url: "./firmware/beta.bin",
    },
];

const ui = {
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    flashBtn: document.getElementById("flashBtn"),
    deviceDot: document.getElementById("deviceDot"),
    deviceLabel: document.getElementById("deviceLabel"),
    latestChannel: document.getElementById("latestChannel"),
    latestUrl: document.getElementById("latestUrl"),
    latestSourceGroup: document.getElementById("latestSourceGroup"),
    customSourceGroup: document.getElementById("customSourceGroup"),
    customFile: document.getElementById("customFile"),
    sourceModeInputs: document.querySelectorAll('input[name="sourceMode"]'),
    progressBar: document.getElementById("progressBar"),
    statusText: document.getElementById("statusText"),
    log: document.getElementById("log"),
    deviceSection: document.getElementById("deviceSection"),
    firmwareSection: document.getElementById("firmwareSection"),
    progressBarSection: document.getElementById("progressBarSection"),
};

const state = {
    device: null,
    webdfu: null,
    connected: false,
    flashing: false,
};

function log(msg) {
    const stamp = new Date().toLocaleTimeString();
    ui.log.textContent += `[${stamp}] ${msg}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function setStatus(text, level = "normal") {
    ui.statusText.textContent = text;
    ui.statusText.classList.remove("warn", "error");
    if (level === "warn" || level === "error") {
        ui.statusText.classList.add(level);
    }
}

function setProgress(ratio) {
    const clamped = Math.max(0, Math.min(1, ratio));
    ui.progressBar.style.width = `${(clamped * 100).toFixed(1)}%`;
}

function getSourceMode() {
    const checked = [...ui.sourceModeInputs].find((input) => input.checked);
    return checked ? checked.value : "latest";
}

function updateSourceModeUI() {
    const isLatest = getSourceMode() === "latest";
    ui.latestSourceGroup.hidden = !isLatest;
    ui.customSourceGroup.hidden = isLatest;
}

function updateControls() {
    ui.connectBtn.disabled = state.connected || state.flashing;
    ui.disconnectBtn.disabled = !state.connected || state.flashing;
    ui.flashBtn.disabled = !state.connected || state.flashing;

    ui.customFile.disabled = state.flashing;
    ui.latestChannel.disabled = state.flashing;
    ui.latestUrl.disabled = state.flashing;

    if (state.connected) {
        ui.deviceDot.classList.add("connected");
    } else {
        ui.deviceDot.classList.remove("connected");
    }

    if (state.flashing) {
        ui.progressBarSection.classList.add("active");
        ui.deviceSection.classList.remove("active");
        ui.firmwareSection.classList.remove("active");
    } else {
        ui.progressBarSection.classList.remove("active");
        if (state.connected) {
            ui.deviceSection.classList.remove("active");
            ui.firmwareSection.classList.add("active");
        } else {
            ui.deviceSection.classList.add("active");
            ui.firmwareSection.classList.remove("active");
        }
    }
}

function loadChannels() {
    ui.latestChannel.innerHTML = "";
    for (const channel of DEFAULT_CHANNELS) {
        const option = document.createElement("option");
        option.value = channel.id;
        option.textContent = channel.label;
        ui.latestChannel.appendChild(option);
    }

    if (DEFAULT_CHANNELS.length > 0) {
        ui.latestUrl.value = DEFAULT_CHANNELS[0].url;
    }
}

function applySelectedChannelUrl() {
    const channel = DEFAULT_CHANNELS.find((item) => item.id === ui.latestChannel.value);
    if (channel) {
        ui.latestUrl.value = channel.url;
    }
}

function ensureWebUSBSupported() {
    if (!navigator.usb) {
        throw new Error("WebUSB is not available in this browser.");
    }
}

async function readFirmwareBinary() {
    const sourceMode = getSourceMode();

    if (sourceMode === "latest") {
        const url = ui.latestUrl.value.trim();
        if (!url) {
            throw new Error("Latest firmware URL is empty.");
        }

        setStatus("Downloading latest firmware...");
        log(`Fetching firmware from ${url}`);

        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Failed to download firmware (${response.status} ${response.statusText}).`);
        }

        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) {
            throw new Error("Downloaded firmware is empty.");
        }

        return {
            name: `latest-${ui.latestChannel.value || "firmware"}.bin`,
            bytes: new Uint8Array(buffer),
        };
    }

    const file = ui.customFile.files && ui.customFile.files[0];
    if (!file) {
        throw new Error("No custom firmware file selected.");
    }

    const buffer = await file.arrayBuffer();
    if (!buffer.byteLength) {
        throw new Error("Selected firmware file is empty.");
    }

    return {
        name: file.name,
        bytes: new Uint8Array(buffer),
    };
}

function createDfuLogger() {
    return {
        info: (msg) => log(`[dfu] ${msg}`),
        warning: (msg) => log(`[dfu warn] ${msg}`),
        progress: (done, total) => {
            if (typeof total === "number" && total > 0) {
                setProgress(done / total);
            }
        },
    };
}

async function connectDevice() {
    ensureWebUSBSupported();

    const device = await navigator.usb.requestDevice({
        filters: [
            { vendorId: 0x4D54, productId: 0x3451, classCode: 0xFE, subclassCode: 0x01 }, // Quantica
        ]
    });
    const webdfu = new WebDFU(device, { forceInterfacesName: true }, createDfuLogger());

    await webdfu.init();
    if (webdfu.interfaces.length === 0) {
        throw new Error("No DFU-capable interface found on selected device.");
    }

    await webdfu.connect(0);

    const props = webdfu.properties || {};
    if (props.CanDownload === false) {
        throw new Error("Connected DFU interface does not support firmware download.");
    }

    state.device = device;
    state.webdfu = webdfu;
    state.connected = true;

    const product = device.productName || "USB Device";
    ui.deviceLabel.textContent = `${product}`;

    setStatus("Device connected and DFU ready.");
    log(`Connected: ${ui.deviceLabel.textContent}`);

    setProgress(0);
    updateControls();
}

async function disconnectDevice() {
    const current = state.webdfu;
    const rawDevice = state.device;

    state.webdfu = null;
    state.device = null;
    state.connected = false;

    try {
        if (current) {
            await current.close();
        } else if (rawDevice && rawDevice.opened) {
            await rawDevice.close();
        }
    } catch (err) {
        log(`Disconnect warning: ${err.message || err}`);
    }

    ui.deviceLabel.textContent = "No device connected";
    setStatus("Disconnected.");
    log("Device disconnected.");
    updateControls();
}

function firmwareToArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function runWriteProcess(writeProcess, totalBytes) {
    await new Promise((resolve, reject) => {
        writeProcess.events.on("erase/start", () => {
            setStatus("Erasing flash...");
            log("Erase started.");
        });

        writeProcess.events.on("erase/process", (bytesSent, expectedSize) => {
            setStatus(`Erasing... ${bytesSent}/${expectedSize} bytes`);
            if (expectedSize > 0) {
                setProgress(bytesSent / expectedSize);
            }
        });

        writeProcess.events.on("write/start", () => {
            setStatus("Writing firmware...");
            log(`Write started: ${totalBytes} bytes`);
            setProgress(0);
        });

        writeProcess.events.on("write/process", (bytesSent, expectedSize) => {
            const total = expectedSize || totalBytes;
            setStatus(`Flashing... ${bytesSent}/${total} bytes`);
            if (total > 0) {
                setProgress(bytesSent / total);
            }
        });

        writeProcess.events.on("verify", (status) => {
            log(`Verify: state=${status.state} status=${status.status}`);
        });

        writeProcess.events.on("error", (error) => {
            reject(error instanceof Error ? error : new Error(String(error)));
        });

        writeProcess.events.on("end", () => {
            resolve();
        });
    });
}

async function flashFirmware() {
    if (!state.webdfu || !state.connected) {
        throw new Error("No device connected.");
    }

    const firmware = await readFirmwareBinary();
    const manifestationTolerant = state.webdfu.properties?.ManifestationTolerant !== false;

    state.flashing = true;
    updateControls();
    setProgress(0);


    let dfu_status = await state.webdfu.getStatus();
    if (dfu_status.state === dfuCommands.appIDLE) {
        log("Device is in appIdle state, sending detach request...");

        await state.webdfu.detach();

        setStatus("Sent detach request, waiting for device to re-enumerate...");
        log("Waiting for device to disconnect and reconnect...");

        await new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                resolve();
            }, 1000);
        });

        state.device = await navigator.usb.requestDevice({
            filters: [
                { vendorId: 0x4D54, productId: 0x3451, classCode: 0xFE, subclassCode: 0x01, protocolCode: 0x02 },
            ]
        });

        state.webdfu = new WebDFU(state.device, { forceInterfacesName: true }, createDfuLogger());

        await state.webdfu.init();
        await state.webdfu.connect(0);
        log("Reconnected to device after detach.");
    }

    const transferSize = state.webdfu.properties?.TransferSize || 1024;
    log(`Using device transfer size: ${transferSize} bytes`);

    try {
        setStatus(`Preparing DFU for ${firmware.name} (${firmware.bytes.length} bytes)...`);
        log(`Starting flash using dfu package: ${firmware.name}`);

        const writeProcess = state.webdfu.write(
            transferSize,
            firmwareToArrayBuffer(firmware.bytes),
            manifestationTolerant,
        );

        await runWriteProcess(writeProcess, firmware.bytes.length);

        setProgress(1);
        await disconnectDevice();

        setStatus("Flash complete. Device will reboot automatically.");
        log("DFU flash completed successfully.");
    } finally {
        state.flashing = false;
        updateControls();
    }
}

async function onConnectClick() {
    try {
        await connectDevice();
    } catch (err) {
        setStatus(err.message || "Failed to connect device.", "error");
        log(`Connect failed: ${err.message || err}`);
        updateControls();
    }
}

async function onDisconnectClick() {
    try {
        await disconnectDevice();
    } catch (err) {
        setStatus(err.message || "Failed to disconnect device.", "error");
        log(`Disconnect failed: ${err.message || err}`);
    }
}

async function onFlashClick() {
    try {
        await flashFirmware();
    } catch (err) {
        setStatus(err.message || "DFU flash failed.", "error");
        log(`Flash failed: ${err.message || err}`);
        state.flashing = false;
        updateControls();
    }
}

function wireEvents() {
    ui.connectBtn.addEventListener("click", onConnectClick);
    ui.disconnectBtn.addEventListener("click", onDisconnectClick);
    ui.flashBtn.addEventListener("click", onFlashClick);

    ui.latestChannel.addEventListener("change", applySelectedChannelUrl);

    for (const input of ui.sourceModeInputs) {
        input.addEventListener("change", updateSourceModeUI);
    }

    // navigator.usb?.addEventListener("disconnect", async (event) => {
    //     if (state.device && event.device === state.device) {
    //         log("USB disconnect event received.");
    //         await disconnectDevice();
    //     }
    // });
}

function init() {
    loadChannels();
    updateSourceModeUI();
    updateControls();
    setProgress(0);
    log("Ready. Connect a device to begin.");
}

wireEvents();
init();
