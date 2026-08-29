/**
 * =====================================================================
 * ioBroker Script: PW Master-Slave Steuerung (Power / Button / Ping)
 * =====================================================================
 * Author:       Speefak
 * Name:         PWSW-Master-Slave
 * Version:      0.2
 * Datum:        2026-07-08
 * Kategorie:    Energie / Automatisierung
 * ---------------------------------------------------------------------
 * Beschreibung:
 *   Automatische Slave-Steuerung eines Zigbee-Actors auf Basis von
 *   mehreren unabhängigen Trigger-Quellen pro Gerätepaar:
 *
 *     1) Power-Sensor (Fritz!DECT o.ä.) mit ON/OFF-Hysterese
 *     2) Zigbee-Button          Single-Click → Slave ON
 *                               Double-Click → Slave OFF
 *     3) Ping-Check eines LAN-Hosts   Online → Slave ON
 *
 * Features:
 *   - Beliebig viele Master/Slave-Paare über config.devices[]
 *   - Debounce NUR für die Power-Hysterese (Flacker-Schutz)
 *   - Button- und Ping-Trigger schalten sofort, ohne Debounce
 *     (löst die 5-10s Verzögerung aus v0.1)
 *   - Ping via child_process (exec), Intervall konfigurierbar
 * ---------------------------------------------------------------------
 * Voraussetzung:
 *   Im JS-Adapter (Instanzeinstellungen) muss unter "Zusätzliche
 *   node_modules" bzw. "additional node modules" "child_process"
 *   freigegeben sein, sonst schlägt der Ping-Check fehl.
 * ---------------------------------------------------------------------
 * Changelog:
 *   v0.1  - Initial: einzelnes Power-Hysterese Master-Slave-Paar
 *   v0.2  - Multi-Device-Config, Button-Trigger, Ping-Check,
 *           entkoppeltes Debounce für schnellere Reaktion
 * =====================================================================
 */

const { exec } = require("child_process");

const config = {
    // === Globale Ping-Einstellungen ===
    ping: {
        intervalMs: 1000,   // Prüfintervall in ms
        timeoutSec: 1        // Ping-Timeout in Sekunden (-W)
    },

    // === Geräte-Paare ===
    devices: [
        {
            name:          "VH_OG1-PW-Büro",

            // Power-Sensor (Hysterese, entprellt)
            sensorPower:   "fritzdect.1.DECT_087610293978.power",  // Watt
            thresholdON:   50,   // Watt → Actor einschalten
            thresholdOFF:  30,   // Watt → Actor ausschalten
            debounceTime:  2000, // ms Verzögerung NUR für Power-Hysterese

            // Zigbee-Button (sofort, kein Debounce)
            buttonSingle:  "zigbee.0.a4c138fdc0fe715d.single",  // → ON
            buttonDouble:  "zigbee.0.a4c138fdc0fe715d.double",  // → OFF

            // Ping-Check (sofort, kein Debounce, nur ON)
            pingHost:      "192.168.1.20",
            pingEnabled:   true,

            // Actor
            actorState:    "zigbee.0.a4c138c18d659a19.state"    // true/false
        }
        // Weiteres Gerät einfach als zusätzliches Objekt hier anhängen
    ],

    logLevel: "info"  // "info", "debug" oder "warn"
};

// Interner State pro Device (Debounce-Timer, Ping-Status)
const deviceState = new Map();

function initDeviceState(dev) {
    deviceState.set(dev.name, {
        debounceTimeout: null,
        pingOnline: false
    });
}

/**
 * Power-Hysterese mit Debounce (wie v0.1, entprellt)
 */
function onPowerChange(dev, value) {
    if (value === null || typeof value !== "number") return;

    const st = deviceState.get(dev.name);
    const currentState = getState(dev.actorState).val;

    if (config.logLevel === "debug") {
        log(`[${dev.name}] Leistung: ${value} W | Actor aktuell: ${currentState}`, "debug");
    }

    if (value >= dev.thresholdON && !currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            setState(dev.actorState, true, false);
            log(`✅ ${dev.name}-Slave EIN (Power: ${value} W >= ${dev.thresholdON} W)`, "info");
        }, dev.debounceTime);
    } else if (value <= dev.thresholdOFF && currentState) {
        if (st.debounceTimeout) clearTimeout(st.debounceTimeout);
        st.debounceTimeout = setTimeout(() => {
            setState(dev.actorState, false, false);
            log(`⛔ ${dev.name}-Slave AUS (Power: ${value} W <= ${dev.thresholdOFF} W)`, "info");
        }, dev.debounceTime);
    }
}

/**
 * Button-Trigger: sofort schalten, kein Debounce
 */
function onButtonSingle(dev) {
    setState(dev.actorState, true, false);
    log(`✅ ${dev.name}-Slave EIN (Button Single-Click)`, "info");
}

function onButtonDouble(dev) {
    setState(dev.actorState, false, false);
    log(`⛔ ${dev.name}-Slave AUS (Button Double-Click)`, "info");
}

/**
 * Ping-Check: Host online → sofort einschalten (nur ON, kein OFF)
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

        // Nur bei Übergang offline → online reagieren (kein Dauer-Schalten)
        if (isOnline && !st.pingOnline) {
            const currentState = getState(dev.actorState).val;
            if (!currentState) {
                setState(dev.actorState, true, false);
                log(`✅ ${dev.name}-Slave EIN (Ping: ${dev.pingHost} online)`, "info");
            }
        }
        st.pingOnline = isOnline;
    });
}

// =============================================
// Skript-Start
// =============================================

config.devices.forEach((dev) => {
    initDeviceState(dev);

    // Power-Trigger
    on({ id: dev.sensorPower, change: "ne" }, (obj) => {
        onPowerChange(dev, obj.state.val);
    });

    // Button-Trigger
    on({ id: dev.buttonSingle, change: "ne" }, () => onButtonSingle(dev));
    on({ id: dev.buttonDouble, change: "ne" }, () => onButtonDouble(dev));

    // Ping-Trigger (Intervall)
    if (dev.pingEnabled) {
        setInterval(() => checkPing(dev), config.ping.intervalMs);
        checkPing(dev); // initialer Check
    }

    // Initialen Power-Wert prüfen
    const initialPower = getState(dev.sensorPower).val;
    if (typeof initialPower === "number") {
        onPowerChange(dev, initialPower);
    }

    log(`🚀 ${dev.name} Master-Slave Skript gestartet (Power/Button/Ping)`, "info");
    log(`[${dev.name}] Schwellwerte: EIN bei ≥ ${dev.thresholdON}W | AUS bei ≤ ${dev.thresholdOFF}W`, "info");
});
