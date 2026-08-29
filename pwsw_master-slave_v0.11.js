/**
 * =====================================================================
 * ioBroker Script: PW Master-Slave Control (Power / Button / Ping)
 * =====================================================================
 * Author:       Speefak
 * Version:      0.11
 * Date:         2026-08-28
 * Category:     Energy / Automation
 * ---------------------------------------------------------------------
 * Description:
 *   Automatic slave actor control based on multiple independent
 *   trigger sources per master/slave pair:
 *
 *     1) Power sensor (Fritz!DECT etc.) with ON/OFF hysteresis
 *     2) Zigbee button   Single-Click → Slave ON
 *                        Double-Click → Slave OFF
 *     3) Ping check of a LAN host      Online → Slave ON (if ping.on)
 *                                      Offline → Slave OFF (if ping.off)
 *     4) Physical switch/button directly on the slave actor (emergency)
 *
 * Features:
 *   - Any number of master/slave pairs via config.devices[]
 *   - Debounce ONLY for the power hysteresis (anti-flicker)
 *   - Button and ping triggers switch immediately, no debounce
 *   - Ping via child_process (exec); all ping parameters (host,
 *     enabled, on/off, interval, timeout, confirm counts) grouped
 *     per-device under dev.ping
 *   - Ping requires N consecutive matching results before acting
 *     (confirmCountOn / confirmCountOff, independently configurable)
 *     to ignore brief NIC-still-alive windows during standby/sleep
 *     transitions
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
 *   v0.7  - Fixed duplicate button triggers (dedupe guard) and a
 *           race where explicit OFF cleared the override immediately,
 *           letting Ping switch the actor back ON a moment later.
 *           ANY manual action (single/double click, physical switch,
 *           either direction) now starts/refreshes the override
 *           window instead of only the ON-triggering ones.
 *   v0.8  - Fixed rapid ON/OFF/ON flapping: Ping's exec() callback is
 *           async and could still fire a stale decision after another
 *           trigger (button/physical/power) had already changed the
 *           actor. Added a re-check of override state + a general
 *           recentlyCommanded() guard (3s settle window) before Power
 *           or Ping issue a command, so two independent trigger
 *           sources can no longer race and fight each other.
 *   v0.9  - Fixed flapping caused by Power and Ping disagreeing during
 *           standby transitions (host briefly still pingable right
 *           after power drops, e.g. NIC WoL nachlauf). Ping now
 *           requires consecutive matching results before acting,
 *           independently configurable for ON (confirmCountOn) and
 *           OFF (confirmCountOff). All ping-related parameters
 *           (host, enabled, on, off, intervalMs, timeoutSec,
 *           confirmCountOn, confirmCountOff) consolidated into a
 *           single dev.ping{} block per device.
 *   v0.10 - Fixed brief ON-then-OFF even while host is truly off:
 *           the power debounce timer committed the ON/OFF command
 *           based on the value captured at trigger time, without
 *           re-reading the sensor when the timer actually fired.
 *           A short spike (inrush/measurement noise) could therefore
 *           trigger an ON that Ping then reverted a few seconds
 *           later. Both debounce branches now re-read the live power
 *           value and current actor state before committing.
 *           Fixed ON/OFF/ON flapping while Ping is positive: exec()
 *           calls could overlap when a lost packet made one ping
 *           run close to the full intervalMs, letting two concurrent
 *           callbacks race on the same pingConsecutive/pingLastResult
 *           counters. Added a per-device in-flight guard so only one
 *           ping is ever outstanding, and switched to "-c 2" to
 *           smooth over single-packet loss during boot/NIC-reinit.
 *   v0.11 - Fixed stale pingConsecutive counter: it only reset on a
 *           raw online/offline value change, not after actually
 *           commanding the actor. If isOnline stayed the same for a
 *           long time (e.g. host online for hours), the counter kept
 *           climbing far past confirmCountOn/Off. If currentState
 *           then diverged from the ping result via another trigger
 *           (override expiry, button, physical switch) without
 *           isOnline itself changing, the very next tick would pass
 *           the confirm-count check immediately with zero fresh
 *           confirmations. pingConsecutive is now reset to 0 right
 *           after every commandActor() call from checkPing, so each
 *           action again requires confirmCountOn/Off fresh results.
 * =====================================================================
 */

const { exec } = require("child_process");

const config = {
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

            // Ping check (all ping params together)
            ping: {
                host:            "192.168.1.20",
                enabled:         true,   // ping check active at all
                on:              true,   // host online  → switch actor ON
                off:             true,   // host offline → switch actor OFF
                intervalMs:      1000,   // ping check interval in ms
                timeoutSec:      1,      // ping timeout in seconds (-W)
                confirmCountOn:  3,      // consecutive "online" results required before switching ON
                confirmCountOff: 3       // consecutive "offline" results required before switching OFF
            },

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
        pingLastResult: null,  // last raw isOnline result from exec()
        pingConsecutive: 0,    // consecutive matching results counter
        pingInFlight: false,   // true while an exec() ping is outstanding
        overrideUntil: null,   // timestamp, Power+Ping suspended while in the future
        lastCommand: null,     // { value, time } of the last command WE sent
        lastTrigger: {}        // per-trigger-key timestamps, for dedupe
    });
}

/**
 * Ignores duplicate triggers (e.g. Zigbee button firing twice for one
 * physical click) arriving within minGapMs of the previous one.
 */
function isDuplicateTrigger(dev, key, minGapMs = 500) {
    const st = deviceState.get(dev.name);
    const now = Date.now();
    const last = st.lastTrigger[key];
    st.lastTrigger[key] = now;
    return last !== undefined && (now - last) < minGapMs;
}

/**
 * True while a command was sent very recently and the actor hasn't
 * had time to settle/confirm yet. Prevents Power and Ping (which run
 * independently and asynchronously) from firing conflicting commands
 * within the same short window, which is what causes rapid ON/OFF/ON
 * flapping when a trigger fires close to a ping/power decision.
 */
function recentlyCommanded(dev, withinMs = 3000) {
    const st = deviceState.get(dev.name);
    return !!(st.lastCommand && (Date.now() - st.lastCommand.time) < withinMs);
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
 *
 * IMPORTANT: the value that triggered scheduling is only used to decide
 * WHETHER to schedule. When the debounce timer actually fires, the live
 * sensor value and actor state are re-read and re-validated — otherwise
 * a short spike (inrush/measurement noise) that has already subsided by
 * the time the timer fires would still commit a stale ON/OFF command.
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
            if (isOverrideActive(dev) || recentlyCommanded(dev)) return; // re-check: state may have changed meanwhile

            const liveVal = getState(dev.sensorPower).val;
            if (typeof liveVal !== "number" || liveVal < dev.thresholdON) {
                if (config.logLevel === "debug") {
                    log(`[${dev.name}] ON debounce aborted: Power dropped back to ${liveVal} W`, "debug");
                }
                return; // spike had already subsided
            }
            if (getState(dev.actorState).val) return; // already ON in the meantime

            commandActor(dev, true);
            log(`✅ ${dev.name}-Slave ON (Power: ${liveVal} W >= ${dev.thresholdON} W)`, "info");
        }, dev.debounceTime);
    } else if (value <= dev.thresholdOFF && currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            if (isOverrideActive(dev) || recentlyCommanded(dev)) return;

            const liveVal = getState(dev.sensorPower).val;
            if (typeof liveVal !== "number" || liveVal > dev.thresholdOFF) {
                if (config.logLevel === "debug") {
                    log(`[${dev.name}] OFF debounce aborted: Power rose back to ${liveVal} W`, "debug");
                }
                return; // spike had already subsided
            }
            if (!getState(dev.actorState).val) return; // already OFF in the meantime

            commandActor(dev, false);
            log(`⛔ ${dev.name}-Slave OFF (Power: ${liveVal} W <= ${dev.thresholdOFF} W)`, "info");
        }, dev.debounceTime);
    }
}

/**
 * Script button trigger: switch immediately, no debounce.
 * Any manual click (ON or OFF) starts/refreshes the override window.
 */
function onButtonSingle(dev) {
    if (isDuplicateTrigger(dev, "buttonSingle")) return;
    commandActor(dev, true);
    startOverride(dev);
    log(`✅ ${dev.name}-Slave ON (Button Single-Click)`, "info");
}

function onButtonDouble(dev) {
    if (isDuplicateTrigger(dev, "buttonDouble")) return;
    commandActor(dev, false);
    startOverride(dev);
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
    if (isDuplicateTrigger(dev, "actorAck")) return;

    const st = deviceState.get(dev.name);
    const isOwnEcho = st.lastCommand
        && state.val === st.lastCommand.value
        && (Date.now() - st.lastCommand.time) < 8000;
    if (isOwnEcho) return; // just confirmation of a command we sent, not manual

    startOverride(dev);
    if (state.val === true) {
        log(`⚠️ ${dev.name}-Slave ON via physical switch on actor (emergency)`, "info");
    } else {
        log(`ℹ️ ${dev.name}-Slave OFF via physical switch on actor`, "info");
    }
}

/**
 * Ping check: host online → actor ON (if dev.ping.on), host offline →
 * actor OFF (if dev.ping.off). Runs every dev.ping.intervalMs, only
 * calls setState on change. Fully skipped during override window.
 *
 * Requires dev.ping.confirmCountOn / confirmCountOff consecutive
 * matching raw results before acting, to avoid reacting to a brief
 * window where a host going into standby is still pingable for a
 * moment (e.g. NIC WoL nachlauf) right as Power already dropped
 * below threshold.
 *
 * pingInFlight guards against overlapping exec() calls: if a ping
 * with packet loss takes close to the full intervalMs to resolve,
 * the next setInterval tick would otherwise start a second exec()
 * before the first callback ran, and both callbacks would race on
 * the same pingConsecutive/pingLastResult counters — causing
 * spurious ON/OFF/ON flapping even while the host is genuinely
 * reachable.
 */
function checkPing(dev) {
    if (!dev.ping.enabled) return;

    const st = deviceState.get(dev.name);
    if (st.pingInFlight) return; // previous exec() still running

    if (isOverrideActive(dev)) {
        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping check skipped (override active)`, "debug");
        }
        return;
    }

    st.pingInFlight = true;
    const cmd = `ping -c 2 -W ${dev.ping.timeoutSec} ${dev.ping.host}`;
    exec(cmd, (error) => {
        st.pingInFlight = false;

        // Re-check: exec() is async, state may have changed while it ran
        // (button/physical override started, or another command was just sent).
        if (isOverrideActive(dev) || recentlyCommanded(dev)) return;

        const isOnline = !error;

        // Track consecutive matching results before acting
        if (st.pingLastResult === isOnline) {
            st.pingConsecutive++;
        } else {
            st.pingLastResult = isOnline;
            st.pingConsecutive = 1;
        }

        const requiredCount = isOnline ? dev.ping.confirmCountOn : dev.ping.confirmCountOff;

        if (config.logLevel === "debug") {
            log(`[${dev.name}] Ping ${dev.ping.host}: ${isOnline ? "online" : "offline"} (${st.pingConsecutive}/${requiredCount})`, "debug");
        }

        if (st.pingConsecutive < requiredCount) return;

        const currentState = getState(dev.actorState).val;

        if (isOnline && dev.ping.on && !currentState) {
            const confirmedCount = st.pingConsecutive;
            commandActor(dev, true);
            st.pingConsecutive = 0; // erzwingt frische Bestätigungen vor der nächsten Aktion
            log(`✅ ${dev.name}-Slave ON (Ping: ${dev.ping.host} online, confirmed ${confirmedCount}x)`, "info");
        } else if (!isOnline && dev.ping.off && currentState) {
            const confirmedCount = st.pingConsecutive;
            commandActor(dev, false);
            st.pingConsecutive = 0;
            log(`⛔ ${dev.name}-Slave OFF (Ping: ${dev.ping.host} offline, confirmed ${confirmedCount}x)`, "info");
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
    if (dev.ping.enabled) {
        setInterval(() => checkPing(dev), dev.ping.intervalMs);
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
