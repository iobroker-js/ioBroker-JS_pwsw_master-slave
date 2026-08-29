/**
 * =============================================
 * Fritzbox Steckdose → Zigbee Actor Steuerung
 * =============================================
 * 
 * Sensor (Leistung): fritzdect.1.DECT_087610293978.power
 * Actor (Schalter):  zigbee.0.a4c138c18d659a19.state
 * 
 * Funktionsweise:
 * - Bei > ThresholdON  → Actor wird eingeschaltet
 * - Bei < ThresholdOFF → Actor wird ausgeschaltet
 * - Hysterese verhindert schnelles Ein-/Ausschalten
 */

const config = {
    // === Geräte ===
    sensorPower:   "fritzdect.1.DECT_087610293978.power",   // Watt
    actorState:    "zigbee.0.a4c138c18d659a19.state",      // true/false

    // === Schwellwerte ===
    thresholdON:   50,   // Watt → Actor einschalten
    thresholdOFF:  30,   // Watt → Actor ausschalten

    // === Sonstiges ===
    debounceTime:  2000,   // ms Verzögerung (gegen Flackern)
    logLevel:      "info"  // "info", "debug" oder "warn"
};

// Globale Variable für Timeout
let debounceTimeout = null;

/**
 * Hauptfunktion - wird bei Änderung der Leistung aufgerufen
 */
function onPowerChange(value) {
    if (value === null || typeof value !== "number") return;

    const currentState = getState(config.actorState).val;

    // Logging
    if (config.logLevel === "debug") {
        log(`[PowerControl] Leistung: ${value} W | Actor aktuell: ${currentState}`, "debug");
    }

    // ThresholdON überschritten → einschalten
    if (value >= config.thresholdON && !currentState) {
        if (debounceTimeout) clearTimeout(debounceTimeout);
        
        debounceTimeout = setTimeout(() => {
            setState(config.actorState, true, false);
            log(`✅ VH_OG1-PW-Büro-Slave EIN geschaltet (Leistung: ${value} W >= ${config.thresholdON} W)`, "info");
        }, config.debounceTime);
    }
    
    // ThresholdOFF unterschritten → ausschalten
    else if (value <= config.thresholdOFF && currentState) {
        if (debounceTimeout) clearTimeout(debounceTimeout);
        
        debounceTimeout = setTimeout(() => {
            setState(config.actorState, false, false);
            log(`⛔ VH_OG1-PW-Büro-Slave AUS geschaltet: ${value} W <= ${config.thresholdOFF} W)`, "info");
        }, config.debounceTime);
    }
}

// =============================================
// Skript-Start
// =============================================

on({id: config.sensorPower, change: "ne"}, (obj) => {
    onPowerChange(obj.state.val);
});

// Initialen Wert prüfen
const initialPower = getState(config.sensorPower).val;
if (typeof initialPower === "number") {
    onPowerChange(initialPower);
}

log("🚀 PW-VH-OG1-Büro-Master-Slave Skript gestartet", "info");
log(`Schwellwerte: EIN bei ≥ ${config.thresholdON}W | AUS bei ≤ ${config.thresholdOFF}W`, "info");
