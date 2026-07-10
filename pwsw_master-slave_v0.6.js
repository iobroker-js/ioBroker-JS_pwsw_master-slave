/**
 * =====================================================================
 * ioBroker Script: PW Master-Slave Control (Power / Button / Ping)
 * =====================================================================
 * Author:       Speefak
 * Version:      0.6
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
 *     3) Ping check of a LAN host      Online → Slave ON (if pingOn)
 *                                      Offline → Slave OFF (if pingOff)
 *     4) Physical switch/button directly on the slave actor (emergency)
 *
 * Features:
 *   - Any number of master/slave pairs via config.devices[]
 *   - Debounce ONLY for the power hysteresis (anti-flicker)
 *   - Button and ping triggers switch immediately, no debounce
 *   - Ping via child_process (exec), interval configurable in ms
 *   - pingOn / pingOff independently configurable per device
 *   - Manual override (emergency): switching the slave ON via the
 *     script button (single click) OR via the physical switch on the
 *     actor itself suspends BOTH power-sensor and ping logic for
 *     config.override.durationMs (default 5 minutes). Use case: PC
 *     not reachable via LAN / ping broken / power sensor not working
 *     → slave can still be forced ON manually and stays ON for the
 *     override window instead of being switched back OFF immediately
 *     by ping or power hysteresis. After the window expires, normal
 *     automatic control resumes. Any explicit OFF (double click or
 *     physical switch OFF) cancels the override immediately.
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
 *   v0.5  - Manual override suppressing ping until next OFF (removed)
 *   v0.6  - Reworked override to a fixed time window (default 5 min)
 *           that suspends Power AND Ping (not just Ping); added
 *           pingOn / pingOff as independent per-device switches
 * =====================================================================
 */

const { exec } = require("child_process");

const config = {
    // === Global ping settings ===
    ping: {
        intervalMs: 1000,    // ping check interval in ms
        timeoutSec: 1        // ping timeout in seconds (-W)
    },

    // === Emergency manual override ===
    override: {
        durationMs: 5 * 60 * 1000   // 5 minutes - suspends Power+Ping checks
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
            buttonSingle:  "zigbee.0.a4c138fdc0fe715d.single",  // → ON + starts override
            buttonDouble:  "zigbee.0.a4c138fdc0fe715d.double",  // → OFF + cancels override

            // Ping check
            pingHost:      "192.168.1.20",
            pingEnabled:   true,   // ping check active at all
            pingOn:        true,   // host online  → switch actor ON
            pingOff:       true,   // host offline → switch actor OFF

            // Actor
            actorState:    "zigbee.0.a4c138c18d659a19.state"    // true/false
        }
        // Add further devices as additional objects here
    ],

    logLevel: "info"  // "info", "debug" or "warn"
};

// Internal per-device state (debounce timer, ping status, override window)
const deviceState = new Map();

function initDeviceState(dev) {
    deviceState.set(dev.name, {
        debounceTimeout: null,
        pingOnline: false,
        overrideUntil: null,   // timestamp, Power+Ping suspended while in the future
        lastCommand: null      // { value, time } of the last command WE sent
    });
}

/**
 * Central actor command wrapper. Every ON/OFF request from any trigger
 * goes through here so we can filter our own echo when the actor
 * confirms the state change (ack:true).
 */
function commandActor(dev, value) {
    const st = deviceState.get(dev.name);
    st.lastCommand = { value, time: Date.now() };
    setState(dev.actorState, value, false);
}

/**
 * Starts the emergency override window: Power + Ping checks are
 * suspended for config.override.durationMs.
 */
function startOverride(dev) {
    const st = deviceState.get(dev.name);
    st.overrideUntil = Date.now() + config.override.durationMs;
    const minutes = Math.round(config.override.durationMs / 60000);
    log(`⚠️ ${dev.name}: manual override active for ${minutes} min (Power+Ping suspended)`, "info");
}

/**
 * Cancels the override immediately (e.g. explicit OFF).
 */
function clearOverride(dev) {
    const st = deviceState.get(dev.name);
    if (st.overrideUntil) {
        st.overrideUntil = null;
        log(`ℹ️ ${dev.name}: manual override cancelled, resuming automatic Power/Ping control`, "info");
    }
}

/**
 * Returns true while the override window is active. Automatically
 * clears + logs expiry once the window has passed.
 */
function isOverrideActive(dev) {
    const st = deviceState.get(dev.name);
    if (!st.overrideUntil) return false;
    if (Date.now() < st.overrideUntil) return true;

    st.overrideUntil = null;
    log(`ℹ️ ${dev.name}: manual override expired, resuming automatic Power/Ping control`, "info");
    return false;
}

/**
 * Power hysteresis with debounce (anti-flicker). Suspended during override.
 */
function onPowerChange(dev, value) {
    if (value === null || typeof value !== "number") return;
    if (isOverrideActive(dev)) return;

    const st = deviceState.get(dev.name);
    const currentState = getState(dev.actorState).val;

    if (config.logLevel === "debug") {
        log(`[${dev.name}] Power: ${value} W | Actor current: ${currentState}`, "debug");
    }

    if (value >= dev.thresholdON && !currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            if (isOverrideActive(dev)) return; // re-check: override may have started meanwhile
            commandActor(dev, true);
            log(`✅ ${dev.name}-Slave ON (Power: ${value} W >= ${dev.thresholdON} W)`, "info");
        }, dev.debounceTime);
    } else if (value <= dev.thresholdOFF && currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            if (isOverrideActive(dev)) return;
            commandActor(dev, false);
            log(`⛔ ${dev.name}-Slave OFF (Power: ${value} W <= ${dev.thresholdOFF} W)`, "info");
        }, dev.debounceTime);
    }
}

/**
 * Script button trigger: switch immediately, no debounce.
 * Single click ALSO starts the emergency override window.
 */
function onButtonSingle(dev) {
    commandActor(dev, true);
    startOverride(dev);
    log(`✅ ${dev.name}-Slave ON (Button Single-Click)`, "info");
}

function onButtonDouble(dev) {
    commandActor(dev, false);
    clearOverride(dev);
    log(`⛔ ${dev.name}-Slave OFF (Button Double-Click)`, "info");
}

/**
 * Detects manual switching directly at the actor (physical
 * switch/button on the socket itself, emergency use). The actor
 * reports its real state with ack:true, both after confirming our
 * own commands AND after a physical toggle. We filter out our own
 * echo via lastCommand; anything else is a physical/manual change:
 * ON → start override window, OFF → cancel override.
 */
function onActorAckChange(dev, state) {
    if (!state.ack) return; // ignore our own command writes (ack:false)

    const st = deviceState.get(dev.name);
    const isOwnEcho = st.lastCommand
        && state.val === st.lastCommand.value
        && (Date.now() - st.lastCommand.time) < 5000;
    if (isOwnEcho) return; // just confirmation of a command we sent, not manual

    if (state.val === true) {
        startOverride(dev);
        log(`⚠️ ${dev.name}-Slave ON via physical switch on actor (emergency)`, "info");
    } else {
        clearOverride(dev);
        log(`ℹ️ ${dev.name}-Slave OFF via physical switch on actor`, "info");
    }
}

/**
 * Ping check: host online → actor ON (if pingOn), host offline →
 * actor OFF (if pingOff). Runs every config.ping.intervalMs, only
 * calls setState on change. Fully skipped during override window.
 */
function checkPing(dev) {
    if (!dev.pingEnabled) return;
    if (isOverrideActive(dev)) {
        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping check skipped (override active)`, "debug");
        }
        return;
    }

    const st = deviceState.get(dev.name);
    const cmd = `ping -c 1 -W ${config.ping.timeoutSec} ${dev.pingHost}`;
    exec(cmd, (error) => {
        const isOnline = !error;

        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping ${dev.pingHost}: ${isOnline ? "online" : "offline"}`, "debug");
        }

        const currentState = getState(dev.actorState).val;

        if (isOnline && dev.pingOn && !currentState) {
            commandActor(dev, true);
            log(`✅ ${dev.name}-Slave ON (Ping: ${dev.pingHost} online)`, "info");
        } else if (!isOnline && dev.pingOff && currentState) {
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

    // Physical switch/button on the actor itself (any ack:true change)
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
