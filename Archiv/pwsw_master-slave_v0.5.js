/**
 * =====================================================================
 * ioBroker Script: PW Master-Slave Control (Power / Button / Ping)
 * =====================================================================
 * Author:       Speefak
 * Version:      0.5
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
 *     3) Ping check of a LAN host      Online → Slave ON, Offline → Slave OFF
 *     4) Physical button directly on the slave actor (manual override)
 *
 * Features:
 *   - Any number of master/slave pairs via config.devices[]
 *   - Debounce ONLY for the power hysteresis (anti-flicker)
 *   - Button and ping triggers switch immediately, no debounce
 *   - Ping via child_process (exec), interval configurable in ms
 *   - Manual override: switching the slave ON via the script button
 *     (single click) OR via the physical button on the actor itself
 *     suppresses the ping check until the slave is switched OFF again
 *     (by double click, physical button, or power hysteresis).
 *     This guarantees the slave can always be forced ON manually,
 *     e.g. if the LAN cable / ping target is broken, without the
 *     ping check immediately switching it back OFF.
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
 *   v0.4  - Ping check now drives actor state directly every interval:
 *           host online → actor ON, host offline → actor OFF
 *   v0.5  - Manual override: script button + physical actor button
 *           suppress ping check until slave is switched OFF again
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
            buttonSingle:  "zigbee.0.a4c138fdc0fe715d.single",  // → ON (manual override)
            buttonDouble:  "zigbee.0.a4c138fdc0fe715d.double",  // → OFF (clears override)

            // Ping check (immediate, no debounce, drives ON and OFF)
            pingHost:      "192.168.1.20",
            pingEnabled:   true,

            // Actor
            actorState:    "zigbee.0.a4c138c18d659a19.state"    // true/false
        }
        // Add further devices as additional objects here
    ],

    logLevel: "info"  // "info", "debug" or "warn"
};

// Internal per-device state (debounce timer, ping status, manual override)
const deviceState = new Map();

function initDeviceState(dev) {
    deviceState.set(dev.name, {
        debounceTimeout: null,
        pingOnline: false,
        manualOverride: false,     // true = ping check is suppressed
        lastCommand: null          // { value, time } of the last command WE sent
    });
}

/**
 * Central actor command wrapper. Every ON/OFF request from any trigger
 * goes through here so we can (a) filter our own echo when the actor
 * confirms the state change (ack:true) and (b) clear the manual
 * override automatically whenever the slave is switched OFF.
 */
function commandActor(dev, value) {
    const st = deviceState.get(dev.name);
    st.lastCommand = { value, time: Date.now() };
    if (value === false) st.manualOverride = false; // any OFF clears the override
    setState(dev.actorState, value, false);
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
            commandActor(dev, true);
            log(`✅ ${dev.name}-Slave ON (Power: ${value} W >= ${dev.thresholdON} W)`, "info");
        }, dev.debounceTime);
    } else if (value <= dev.thresholdOFF && currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            commandActor(dev, false);
            log(`⛔ ${dev.name}-Slave OFF (Power: ${value} W <= ${dev.thresholdOFF} W)`, "info");
        }, dev.debounceTime);
    }
}

/**
 * Script button trigger: switch immediately, no debounce.
 * Single click ALSO activates manual override (suppresses ping).
 */
function onButtonSingle(dev) {
    const st = deviceState.get(dev.name);
    commandActor(dev, true);
    st.manualOverride = true;
    log(`✅ ${dev.name}-Slave ON (Button Single-Click, ping suppressed until next OFF)`, "info");
}

function onButtonDouble(dev) {
    commandActor(dev, false);
    log(`⛔ ${dev.name}-Slave OFF (Button Double-Click, override cleared)`, "info");
}

/**
 * Detects manual switching directly at the actor (physical button on
 * the socket itself). The actor reports its real state with ack:true,
 * both after confirming our own commands AND after a physical button
 * press. We filter out our own echo via lastCommand; anything else is
 * a physical/manual change and is treated exactly like the script
 * button: ON → activate override, OFF → clear override.
 */
function onActorAckChange(dev, state) {
    if (!state.ack) return; // ignore our own command writes (ack:false)

    const st = deviceState.get(dev.name);
    const isOwnEcho = st.lastCommand
        && state.val === st.lastCommand.value
        && (Date.now() - st.lastCommand.time) < 5000;
    if (isOwnEcho) return; // just confirmation of a command we sent, not manual

    if (state.val === true) {
        st.manualOverride = true;
        log(`⚠️ ${dev.name}-Slave ON via physical button on actor (ping suppressed until next OFF)`, "info");
    } else {
        st.manualOverride = false;
        log(`ℹ️ ${dev.name}-Slave OFF via physical button on actor (override cleared)`, "info");
    }
}

/**
 * Ping check: host online → actor ON, host offline → actor OFF.
 * Runs every config.ping.intervalMs, only calls setState on change.
 * Fully skipped while manual override is active.
 */
function checkPing(dev) {
    if (!dev.pingEnabled || !dev.pingHost) return;

    const st = deviceState.get(dev.name);
    if (st.manualOverride) {
        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping check skipped (manual override active)`, "debug");
        }
        return;
    }

    const cmd = `ping -c 1 -W ${config.ping.timeoutSec} ${dev.pingHost}`;
    exec(cmd, (error) => {
        const isOnline = !error;

        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping ${dev.pingHost}: ${isOnline ? "online" : "offline"}`, "debug");
        }

        const currentState = getState(dev.actorState).val;

        if (isOnline && !currentState) {
            commandActor(dev, true);
            log(`✅ ${dev.name}-Slave ON (Ping: ${dev.pingHost} online)`, "info");
        } else if (!isOnline && currentState) {
            commandActor(dev, false);
            log(`⛔ ${dev.name}-Slave OFF (Ping: ${dev.pingHost} offline)`, "info");
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

    // Script button trigger
    on({ id: dev.buttonSingle, change: "ne" }, () => onButtonSingle(dev));
    on({ id: dev.buttonDouble, change: "ne" }, () => onButtonDouble(dev));

    // Physical button on the actor itself (any ack:true change on the actor state)
    on({ id: dev.actorState, change: "ne" }, (obj) => {
        onActorAckChange(dev, obj.state);
    });

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
