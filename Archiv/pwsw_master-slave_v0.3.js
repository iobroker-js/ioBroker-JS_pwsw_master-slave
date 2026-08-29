/**
 * =====================================================================
 * ioBroker Script: PW Master-Slave Control (Power / Button / Ping)
 * =====================================================================
 * Author:       Speefak
 * Version:      0.3
 * Date:         2026-07-09
 * Category:     Energy / Automation
 * ---------------------------------------------------------------------
 * Description:
 *   Automatic slave actor control based on multiple independent
 *   trigger sources per master/slave pair:
 *
 *     1) Power sensor (Fritz!DECT etc.) with ON/OFF hysteresis
 *     2) Zigbee button   Single-Click → Slave ON
 *                        Double-Click → Slave OFF
 *     3) Ping check of a LAN host      Online → Slave ON
 *
 * Features:
 *   - Any number of master/slave pairs via config.devices[]
 *   - Debounce ONLY for the power hysteresis (anti-flicker)
 *   - Button and ping triggers switch immediately, no debounce
 *   - Ping via child_process (exec), interval configurable in ms
 * ---------------------------------------------------------------------
 * Requirement:
 *   The JS-Controller instance settings must allow "child_process"
 *   under "additional node modules", otherwise the ping check fails.
 * ---------------------------------------------------------------------
 * Changelog:
 *   v0.1  - Initial: single power-hysteresis master/slave pair
 *   v0.2  - Multi-device config, button trigger, ping check,
 *           decoupled debounce for faster reaction
 *   v0.3  - Full English, ping interval reduced to 1000 ms default
 * =====================================================================
 */

const { exec } = require("child_process");

const config = {
    // === Global ping settings ===
    ping: {
        intervalMs: 1000,    // ping check interval in ms
        timeoutSec: 1        // ping timeout in seconds (-W)
    },

    // === Device pairs ===
    devices: [
        {
            name:          "VH_OG1-PW-Buero",

            // Power sensor (hysteresis, debounced)
            sensorPower:   "fritzdect.1.DECT_087610293978.power",  // Watt
            thresholdON:   50,   // Watt → switch actor ON
            thresholdOFF:  30,   // Watt → switch actor OFF
            debounceTime:  2000, // ms delay, ONLY for power hysteresis

            // Zigbee button (immediate, no debounce)
            buttonSingle:  "zigbee.0.a4c138fdc0fe715d.single",  // → ON
            buttonDouble:  "zigbee.0.a4c138fdc0fe715d.double",  // → OFF

            // Ping check (immediate, no debounce, ON only)
            pingHost:      "192.168.1.3",
            pingEnabled:   true,

            // Actor
            actorState:    "zigbee.0.a4c138c18d659a19.state"    // true/false
        }
        // Add further devices as additional objects here
    ],

    logLevel: "info"  // "info", "debug" or "warn"
};

// Internal per-device state (debounce timer, ping status)
const deviceState = new Map();

function initDeviceState(dev) {
    deviceState.set(dev.name, {
        debounceTimeout: null,
        pingOnline: false
    });
}

/**
 * Power hysteresis with debounce (anti-flicker)
 */
function onPowerChange(dev, value) {
    if (value === null || typeof value !== "number") return;

    const st = deviceState.get(dev.name);
    const currentState = getState(dev.actorState).val;

    if (config.logLevel === "debug") {
        log(`[${dev.name}] Power: ${value} W | Actor current: ${currentState}`, "debug");
    }

    if (value >= dev.thresholdON && !currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            setState(dev.actorState, true, false);
            log(`✅ ${dev.name}-Slave ON (Power: ${value} W >= ${dev.thresholdON} W)`, "info");
        }, dev.debounceTime);
    } else if (value <= dev.thresholdOFF && currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            setState(dev.actorState, false, false);
            log(`⛔ ${dev.name}-Slave OFF (Power: ${value} W <= ${dev.thresholdOFF} W)`, "info");
        }, dev.debounceTime);
    }
}

/**
 * Button trigger: switch immediately, no debounce
 */
function onButtonSingle(dev) {
    setState(dev.actorState, true, false);
    log(`✅ ${dev.name}-Slave ON (Button Single-Click)`, "info");
}

function onButtonDouble(dev) {
    setState(dev.actorState, false, false);
    log(`⛔ ${dev.name}-Slave OFF (Button Double-Click)`, "info");
}

/**
 * Ping check: host online → switch on immediately (ON only, no OFF)
 */
function checkPing(dev) {
    if (!dev.pingEnabled || !dev.pingHost) return;

    const cmd = `ping -c 1 -W ${config.ping.timeoutSec} ${dev.pingHost}`;
    exec(cmd, (error) => {
        const st = deviceState.get(dev.name);
        const isOnline = !error;

        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping ${dev.pingHost}: ${isOnline ? "online" : "offline"}`, "debug");
        }

        // Only react on offline → online transition (no continuous switching)
        if (isOnline && !st.pingOnline) {
            const currentState = getState(dev.actorState).val;
            if (!currentState) {
                setState(dev.actorState, true, false);
                log(`✅ ${dev.name}-Slave ON (Ping: ${dev.pingHost} online)`, "info");
            }
        }
        st.pingOnline = isOnline;
    });
}

// =============================================
// Script start
// =============================================

config.devices.forEach((dev) => {
    initDeviceState(dev);

    // Power trigger
    on({ id: dev.sensorPower, change: "ne" }, (obj) => {
        onPowerChange(dev, obj.state.val);
    });

    // Button trigger
    on({ id: dev.buttonSingle, change: "ne" }, () => onButtonSingle(dev));
    on({ id: dev.buttonDouble, change: "ne" }, () => onButtonDouble(dev));

    // Ping trigger (interval)
    if (dev.pingEnabled) {
        setInterval(() => checkPing(dev), config.ping.intervalMs);
        checkPing(dev); // initial check
    }

    // Check initial power value
    const initialPower = getState(dev.sensorPower).val;
    if (typeof initialPower === "number") {
        onPowerChange(dev, initialPower);
    }

    log(`🚀 ${dev.name} master-slave script started (Power/Button/Ping)`, "info");
    log(`[${dev.name}] Thresholds: ON at >= ${dev.thresholdON}W | OFF at <= ${dev.thresholdOFF}W`, "info");
});
