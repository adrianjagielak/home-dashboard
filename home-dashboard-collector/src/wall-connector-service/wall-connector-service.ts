import axios from "axios";
import { Point, WriteApi } from "@influxdata/influxdb-client";
import winston from "winston";
import { AppConfig } from "../config-model";
import { WallConnectorVitals, WallConnectorData } from "./wall-connector-model";

const POLL_INTERVAL = 250; // 4 times per second (250ms)
const POLL_TIMEOUT = 1000; // 1 second timeout for requests

let influxWriteApi: WriteApi;
let logger: winston.Logger;
let getConfig: () => AppConfig;
let wallConnectorData: WallConnectorData;
let pollInterval: NodeJS.Timeout | null = null;
let isPolling = false;

export function initWallConnectorService(
  writeApi: WriteApi,
  log: winston.Logger,
  configGetter: () => AppConfig,
) {
  influxWriteApi = writeApi;
  logger = log;
  getConfig = configGetter;
  wallConnectorData = {
    readings: [],
  };

  startWallConnectorService();
  logger.info("Wall Connector service initialized");
}

async function startWallConnectorService() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  pollInterval = setInterval(pollWallConnector, POLL_INTERVAL);
}

export function refreshWallConnectorService() {
  logger.info("Refreshing Wall Connector service...");
  startWallConnectorService();
}

async function pollWallConnector() {
  if (isPolling) return;
  isPolling = true;

  try {
    const response = await axios.get<WallConnectorVitals>(
      `http://${getConfig().wallConnector.ip}/api/1/vitals`,
      { timeout: POLL_TIMEOUT },
    );

    const vitals = response.data;
    const now = Date.now();

    // Store reading if charging
    if (vitals.contactor_closed) {
      wallConnectorData.readings.push({
        timestamp: now,
        current: vitals.currentA_a,
        voltage: vitals.voltageA_v,
        charging: true,
      });
    }

    // Write all vitals to InfluxDB
    const point = new Point("raw_wall_connector")
      .tag("device", "tesla")
      .booleanField("contactor_closed", vitals.contactor_closed)
      .booleanField("vehicle_connected", vitals.vehicle_connected)
      .intField("session_s", vitals.session_s)
      .floatField("grid_v", vitals.grid_v)
      .floatField("grid_hz", vitals.grid_hz)
      .floatField("vehicle_current_a", vitals.vehicle_current_a)
      .floatField("currentA_a", vitals.currentA_a)
      .floatField("currentB_a", vitals.currentB_a)
      .floatField("currentC_a", vitals.currentC_a)
      .floatField("currentN_a", vitals.currentN_a)
      .floatField("voltageA_v", vitals.voltageA_v)
      .floatField("voltageB_v", vitals.voltageB_v)
      .floatField("voltageC_v", vitals.voltageC_v)
      .floatField("relay_coil_v", vitals.relay_coil_v)
      .floatField("pcba_temp_c", vitals.pcba_temp_c)
      .floatField("handle_temp_c", vitals.handle_temp_c)
      .floatField("mcu_temp_c", vitals.mcu_temp_c)
      .intField("uptime_s", vitals.uptime_s)
      .intField("input_thermopile_uv", vitals.input_thermopile_uv)
      .floatField("prox_v", vitals.prox_v)
      .floatField("pilot_high_v", vitals.pilot_high_v)
      .floatField("pilot_low_v", vitals.pilot_low_v)
      .floatField("session_energy_wh", vitals.session_energy_wh)
      .intField("config_status", vitals.config_status)
      .intField("evse_state", vitals.evse_state)
      .stringField("current_alerts", JSON.stringify(vitals.current_alerts))
      .stringField(
        "evse_not_ready_reasons",
        JSON.stringify(vitals.evse_not_ready_reasons),
      );

    influxWriteApi.writePoint(point);

    logger.debug("Wall Connector vitals received", {
      charging: vitals.contactor_closed,
      current: vitals.currentA_a,
      voltage: vitals.voltageA_v,
      power: vitals.contactor_closed
        ? vitals.currentA_a * vitals.voltageA_v
        : 0,
      sessionEnergy: vitals.session_energy_wh,
    });
  } catch (error) {
    logger.error("Error polling Wall Connector", {
      error: (error as Error).message,
    });
  } finally {
    isPolling = false;
  }
}

export function aggregateWallConnectorData(): void {
  const now = new Date();
  const timestamp = new Date(now.setSeconds(0, 0));

  // Filter only charging readings
  const chargingReadings = wallConnectorData.readings.filter((r) => r.charging);

  if (chargingReadings.length > 0) {
    // Calculate time-weighted average current and voltage
    let totalEnergy = 0;
    let weightedCurrentSum = 0;
    let weightedVoltageSum = 0;
    let totalDuration = 0;

    for (let i = 0; i < chargingReadings.length; i++) {
      const reading = chargingReadings[i];
      const nextReading = chargingReadings[i + 1];

      // Calculate duration for this reading
      let duration;
      if (nextReading) {
        duration = (nextReading.timestamp - reading.timestamp) / 1000; // convert to seconds
      } else {
        duration = (now.getTime() - reading.timestamp) / 1000;
      }

      // Calculate energy for this period (Wh)
      const power = reading.current * reading.voltage;
      totalEnergy += (power * duration) / 3600; // convert W*s to Wh

      // Add weighted values for averages
      weightedCurrentSum += reading.current * duration;
      weightedVoltageSum += reading.voltage * duration;
      totalDuration += duration;
    }

    // Calculate time-weighted averages
    const avgCurrent = weightedCurrentSum / totalDuration;
    const avgVoltage = weightedVoltageSum / totalDuration;

    // Write aggregated data point
    const point = new Point("aggregated_energy")
      .tag("device", "tesla")
      .floatField("consumption", totalEnergy)
      .floatField("avg_current", avgCurrent)
      .floatField("avg_voltage", avgVoltage)
      .timestamp(timestamp);

    influxWriteApi.writePoint(point);

    logger.info("Aggregated Wall Connector data", {
      energyConsumption: totalEnergy,
      avgCurrent,
      avgVoltage,
      readingsCount: chargingReadings.length,
    });
  } else {
    logger.debug("No charging readings to aggregate for Wall Connector");
  }

  // Reset readings array
  wallConnectorData.readings = [];
}
