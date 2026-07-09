import { WebDFU, dfuCommands } from "dfu";

const STABLE_RELEASES = [
    { version: "1.0.1-stable", url: "/firmware/1.0.1-stable.bin" },
];

const BETA_RELEASES = [
        { version: "1.0.2-beta", url: "/firmware/1.0.2-beta.bin" },
];

const ui = {
    connectBtn: document.getElementById("connectBtn"),
    disconnectBtn: document.getElementById("disconnectBtn"),
    flashBtn: document.getElementById("flashBtn"),
    deviceDot: document.getElementById("deviceDot"),
    deviceLabel: document.getElementById("deviceLabel"),
    stableVersion: document.getElementById("stableVersion"),
    stableUrl: document.getElementById("stableUrl"),
    betaVersion: document.getElementById("betaVersion"),
    betaUrl: document.getElementById("betaUrl"),
    customFile: document.getElementById("customFile"),
    progressBar: document.querySelector(".progress-bar"),
    statusText: document.getElementById("statusText"),
    log: document.getElementById("log"),
    tabs: {
        stable: document.getElementById("stable-tab"),
        beta: document.getElementById("beta-tab"),
        custom: document.getElementById("custom-tab"),
    },
};

const state = {
    device: null,
    webdfu: null,
    connected: false,
    flashing: false,
};

function log(message) {
    const stamp = new Date().toLocaleTimeString();
    ui.log.textContent += `[${stamp}] ${message}\n`;
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

function setSelectOptions(select, releases) {
    select.innerHTML = "";
    for (const release of releases) {
        const option = document.createElement("option");
        option.value = release.version;
        option.textContent = release.version;
        select.appendChild(option);
    }
}

function getActiveSourceMode() {
    if (ui.tabs.custom.classList.contains("active")) {
        return "custom";
    }
    if (ui.tabs.beta.classList.contains("active")) {
        return "beta";
    }
    return "stable";
}

function updateSelectedUrls() {
    const stable = STABLE_RELEASES.find((item) => item.version === ui.stableVersion.value);
    ui.stableUrl.value = stable ? stable.url : "";

    const beta = BETA_RELEASES.find((item) => item.version === ui.betaVersion.value);
    ui.betaUrl.value = beta ? beta.url : "";
}

function updateControls() {
    const sourceMode = getActiveSourceMode();
    const hasCustomFile = Boolean(ui.customFile.files && ui.customFile.files[0]);
    const sourceReady = sourceMode !== "custom" || hasCustomFile;

    ui.connectBtn.disabled = state.connected || state.flashing;
    ui.disconnectBtn.disabled = !state.connected || state.flashing;
    ui.flashBtn.disabled = !state.connected || state.flashing || !sourceReady;

    ui.stableVersion.disabled = state.flashing;
    ui.betaVersion.disabled = state.flashing;
    ui.customFile.disabled = state.flashing;

    if (state.connected) {
        ui.deviceDot.classList.add("connected");
    } else {
        ui.deviceDot.classList.remove("connected");
    }
}

function ensureWebUSBSupported() {
    if (!navigator.usb) {
        throw new Error("WebUSB is not available in this browser.");
    }
}

async function fetchFirmwareFromUrl(url, nameHint) {
    if (!url) {
        throw new Error("Firmware URL is empty.");
    }

    setStatus("Downloading firmware...");
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
        name: `${nameHint}.bin`,
        bytes: new Uint8Array(buffer),
    };
}

async function readFirmwareBinary() {
    const sourceMode = getActiveSourceMode();

    if (sourceMode === "stable") {
        return fetchFirmwareFromUrl(ui.stableUrl.value.trim(), `stable-${ui.stableVersion.value || "firmware"}`);
    }

    if (sourceMode === "beta") {
        return fetchFirmwareFromUrl(ui.betaUrl.value.trim(), `beta-${ui.betaVersion.value || "firmware"}`);
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

async function reconnectInDfuMode() {
    log("Device is in appIdle state, sending detach request...");
    await state.webdfu.detach();

    setStatus("Sent detach request, waiting for device to re-enumerate...");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    state.device = await navigator.usb.requestDevice({
        filters: [
            { vendorId: 0x4D54, productId: 0x3451, classCode: 0xFE, subclassCode: 0x01, protocolCode: 0x02 },
        ],
    });

    state.webdfu = new WebDFU(state.device, { forceInterfacesName: true }, createDfuLogger());
    await state.webdfu.init();
    await state.webdfu.connect(0);

    log("Reconnected to device after detach.");
}

async function connectDevice() {
    ensureWebUSBSupported();

    const device = await navigator.usb.requestDevice({
        filters: [
            { vendorId: 0x4D54, productId: 0x3451, classCode: 0xFE, subclassCode: 0x01 },
        ],
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

    ui.deviceLabel.textContent = device.productName || "USB Device";

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

    state.flashing = true;
    updateControls();
    setProgress(0);

    const dfuStatus = await state.webdfu.getStatus();
    if (dfuStatus.state === dfuCommands.appIDLE) {
        await reconnectInDfuMode();
    }

    const manifestationTolerant = state.webdfu.properties?.ManifestationTolerant !== false;
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

    ui.stableVersion.addEventListener("change", () => {
        updateSelectedUrls();
        updateControls();
    });

    ui.betaVersion.addEventListener("change", () => {
        updateSelectedUrls();
        updateControls();
    });

    ui.customFile.addEventListener("change", updateControls);

    ui.tabs.stable.addEventListener("shown.bs.tab", updateControls);
    ui.tabs.beta.addEventListener("shown.bs.tab", updateControls);
    ui.tabs.custom.addEventListener("shown.bs.tab", updateControls);
}

function init() {
    setSelectOptions(ui.stableVersion, STABLE_RELEASES);
    setSelectOptions(ui.betaVersion, BETA_RELEASES);

    updateSelectedUrls();
    updateControls();
    setProgress(0);
    log("Ready. Connect a device to begin.");
}

wireEvents();
init();
