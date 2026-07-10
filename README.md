ioBroker JavaScript for controlling a Zigbee slave actor from multiple independent trigger sources: a power sensor with hysteresis, a Zigbee remote button, a LAN ping check, and the physical switch on the actor itself.

## Features

- **Power hysteresis** — turns the slave ON above a configurable wattage threshold and OFF below a lower threshold, with debounce to prevent flickering.
- **Zigbee button** — single click switches the slave ON, double click switches it OFF, both instantly (no debounce).
- **Ping check** — polls a LAN host (e.g. a PC) at a configurable interval; ON and OFF reactions can be enabled independently (`pingOn` / `pingOff`).
- **Physical switch on the actor** — detected automatically via the actor's ack state; treated the same as the script button.
- **Manual override window** — any manual action (button click or physical switch, either direction) suspends Power *and* Ping logic for a configurable duration (default 5 minutes). This guarantees the slave stays exactly where you left it even if the power sensor or ping target is unreachable, instead of being overridden by automation a moment later.
- **Multi-device** — any number of master/slave pairs, defined as entries in `config.devices[]`.

## Requirements

- ioBroker with the `javascript` adapter (JS-Controller / Blockly-Script engine).
- A Zigbee adapter (e.g. `zigbee2mqtt` or `ioBroker.zigbee`) providing the button and actor states.
- A power-metering device/adapter (e.g. `fritzdect`) providing a Watt state, or any other numeric power state.
- **`child_process`** must be enabled under the JS-Controller instance's "additional node modules" setting — the script uses it to run `ping`.

## Installation

1. Copy `pwsw_master-slave_v0.7.js` into a new ioBroker JavaScript (Node.js scripting engine).
2. Enable `child_process` in the script engine instance settings (Adapter → javascript → Instance settings → additional node modules).
3. Adjust `config.devices[]` (see below) to match your object IDs.
4. Start the script and check the log for the startup messages.

## Configuration

All settings live in the `config` object at the top of the script.

### Global

| Option | Description | Default |
|---|---|---|
| `ping.intervalMs` | Ping check interval in ms | `1000` |
| `ping.timeoutSec` | Ping timeout in seconds (`ping -W`) | `1` |
| `override.durationMs` | Duration the manual override suspends Power + Ping after any manual action | `300000` (5 min) |
| `logLevel` | `"info"`, `"debug"` or `"warn"` | `"info"` |

### Per device (`config.devices[]`)

| Option | Description |
|---|---|
| `name` | Display name used in log messages |
| `sensorPower` | State ID of the power sensor (Watt) |
| `thresholdON` | Watt value at/above which the actor switches ON |
| `thresholdOFF` | Watt value at/below which the actor switches OFF |
| `debounceTime` | Debounce delay in ms, applies only to the power hysteresis |
| `buttonSingle` | State ID of the Zigbee button's single-click action → actor ON |
| `buttonDouble` | State ID of the Zigbee button's double-click action → actor OFF |
| `pingHost` | IP or hostname to ping |
| `pingEnabled` | Enables/disables the ping check entirely |
| `pingOn` | If `true`, host reachable → actor ON |
| `pingOff` | If `true`, host unreachable → actor OFF |
| `actorState` | State ID of the Zigbee actor (`true`/`false`) |

## Logic overview

```
Power sensor  ──► hysteresis (debounced) ──┐
Zigbee button ──► single = ON, double = OFF ├──► actor state
Ping check    ──► host reachable/unreachable┘
Physical switch on actor ──► detected via ack echo
```

Any manual trigger (button click or physical switch, in either direction) starts a **5-minute override window** (configurable) during which Power and Ping logic are suspended for that device. The actor stays exactly in the state the manual action left it in, unaffected by ping timeouts or power-sensor readings, until the window expires or another manual action refreshes it.

## Changelog

| Version | Changes |
|---|---|
| 0.1 | Initial: single power-hysteresis master/slave pair |
| 0.2 | Multi-device config, button trigger, ping check, decoupled debounce |
| 0.3 | Full English, ping interval reduced to 1000 ms |
| 0.4 | Ping check drives actor state directly (ON + OFF) |
| 0.5 | Manual override suppressing ping until next OFF (superseded by v0.6) |
| 0.6 | Time-window override (default 5 min) suspending Power *and* Ping; added `pingOn` / `pingOff` |
| 0.7 | Fixed duplicate button triggers (dedupe guard); explicit OFF now also starts the override window instead of clearing it, preventing ping from immediately re-enabling the actor |

---

This script was created and published free of charge for the open source community. If you find it useful and would like to support future development, consider making a small donation:

```
Bitcoin (BTC): 33AXe8Z8XBuGKx9eHHmGnvbawrNYjSgDcM

Ethereum (ETH): 0xa61d178EA84C2200A8617b51B4bCf98F87ff59Ff

Solana (SOL): BDf5EgsN8fRUicYzeM8cuaNhL7zdty2qsEj2mC2jA4Fm

Ripple (XRP): rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh

Cardano (ADA): addr1q8anur2wvvc6pv3cpp30vv05makyra8huh0lk0yhdk6hcnlrzr27g03klu862usxqsru794d03gzkk8n86ta34n85z0svn5ams   

USTether (USDT): 0xa61d178EA84C2200A8617b51B4bCf98F87ff59Ff

```

Thank you for your support! 🙏
