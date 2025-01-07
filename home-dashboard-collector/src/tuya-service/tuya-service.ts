import TuyAPI from "tuyapi";
import { Point, WriteApi } from "@influxdata/influxdb-client";
import winston from "winston";
import { AppConfig, TuyaDeviceConfig } from "../config-model";
import { TuyaDeviceConnection, TuyaDeviceData } from "./tuya-model";

const INITIAL_BACKOFF_DELAY = 1000; // 1 second
const MAX_BACKOFF_DELAY = 300000; // 5 minutes
const BACKOFF_MULTIPLIER = 1.5;
const POLL_INTERVAL = 1000; // How often to poll (1 second)
const POLL_TIMEOUT = 2000; // Maximum time to wait for response (2 seconds)

let influxWriteApi: WriteApi;
let logger: winston.Logger;
let getConfig: () => AppConfig;
let deviceConnections: Map<string, TuyaDeviceConnection>;
let tuyaDeviceData: Map<string, TuyaDeviceData>;

export function initTuyaService(
  writeApi: WriteApi,
  log: winston.Logger,
  configGetter: () => AppConfig,
) {
  influxWriteApi = writeApi;
  logger = log;
  getConfig = configGetter;
  deviceConnections = new Map();
  tuyaDeviceData = new Map();

  startTuyaService();
  logger.info("Tuya service initialized");
}

async function startTuyaService() {
  await connectAllDevices();
}

export async function refreshTuyaService() {
  logger.info("Refreshing Tuya service connections...");
  await disconnectAllDevices();
  await connectAllDevices();
}

async function connectAllDevices(): Promise<void> {
  const config = getConfig();
  const configuredDevices = new Set(config.tuyaDevices.map((d) => d.id));

  // Remove devices that are no longer in config
  for (const [deviceId] of deviceConnections) {
    if (!configuredDevices.has(deviceId)) {
      await disconnectDevice(deviceId);
    }
  }

  // Connect new or existing devices
  for (const deviceConfig of config.tuyaDevices) {
    if (!deviceConnections.has(deviceConfig.id)) {
      await connectDevice(deviceConfig);
    }
  }
}

async function connectDevice(config: TuyaDeviceConfig): Promise<void> {
  try {
    const device = new TuyAPI({
      id: config.id,
      key: config.localKey,
    });

    const connection: TuyaDeviceConnection = {
      device,
      connected: false,
      backoffDelay: INITIAL_BACKOFF_DELAY,
    };

    deviceConnections.set(config.id, connection);
    tuyaDeviceData.set(config.id, {
      power: [],
      voltage: [],
      current: [],
      lastUpdated: new Date(),
    });

    setupDeviceEventHandlers(config, connection);
    startDeviceConnection(config, connection);
  } catch (error) {
    logger.error("Error creating device connection", {
      deviceId: config.id,
      deviceName: config.deviceName,
      error: (error as Error).message,
    });
    scheduleReconnect(config);
  }
}

function setupDeviceEventHandlers(
  config: TuyaDeviceConfig,
  connection: TuyaDeviceConnection,
): void {
  connection.device.on("connected", () => {
    connection.connected = true;
    connection.backoffDelay = INITIAL_BACKOFF_DELAY;
    logger.info("Device connected", {
      deviceId: config.id,
      deviceName: config.deviceName,
    });
    startDevicePolling(config);
  });

  connection.device.on("disconnected", () => {
    connection.connected = false;
    logger.warn("Device disconnected", {
      deviceId: config.id,
      deviceName: config.deviceName,
    });
    scheduleReconnect(config);
  });

  connection.device.on("error", (error: Error) => {
    connection.lastError = error;
    logger.error("Device error", {
      deviceId: config.id,
      deviceName: config.deviceName,
      error: error.message,
    });
    scheduleReconnect(config);
  });

  connection.device.on("data", (data: any) => {
    handleDeviceDataUpdate(config, data.dps);
  });

  connection.device.on("dp-refresh", (data: any) => {
    handleDeviceDataUpdate(config, data.dps);
  });
}

async function startDeviceConnection(
  config: TuyaDeviceConfig,
  connection: TuyaDeviceConnection,
): Promise<void> {
  try {
    await connection.device.find();
    await connection.device.connect();
  } catch (error) {
    logger.error("Error connecting to device", {
      deviceId: config.id,
      deviceName: config.deviceName,
      error: (error as Error).message,
    });
    scheduleReconnect(config);
  }
}

function scheduleReconnect(config: TuyaDeviceConfig): void {
  const connection = deviceConnections.get(config.id);
  if (!connection) return;

  // Clear any existing reconnection timeout
  if (connection.reconnectTimeout) {
    clearTimeout(connection.reconnectTimeout);
  }

  // Schedule reconnection with current backoff delay
  connection.reconnectTimeout = setTimeout(async () => {
    logger.info("Attempting to reconnect device", {
      deviceId: config.id,
      deviceName: config.deviceName,
      backoffDelay: connection.backoffDelay,
    });

    try {
      await startDeviceConnection(config, connection);
    } catch (error) {
      // Increase backoff delay for next attempt
      connection.backoffDelay = Math.min(
        connection.backoffDelay * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_DELAY,
      );
      scheduleReconnect(config);
    }
  }, connection.backoffDelay);
}

function handleDeviceDataUpdate(config: TuyaDeviceConfig, dps: any): void {
  const deviceData = tuyaDeviceData.get(config.id);
  if (!deviceData) return;

  const now = Date.now();
  let dataUpdated = false;

  // Create InfluxDB point
  const point = new Point("raw_energy").tag("device", config.deviceName);

  // Extract and convert values with proper scaling
  if (dps["19"] !== undefined) {
    // cur_power
    const powerValue = Number(dps["19"]) / 10; // Convert to actual watts
    deviceData.power.push({
      value: powerValue,
      timestamp: now,
    });
    point.floatField("power", powerValue);
    dataUpdated = true;
  }

  if (dps["20"] !== undefined) {
    // cur_voltage
    const voltageValue = Number(dps["20"]) / 10; // Convert to actual volts
    deviceData.voltage.push(voltageValue);
    point.floatField("voltage", voltageValue);
    dataUpdated = true;
  }

  if (dps["18"] !== undefined) {
    // cur_current
    const currentValue = Number(dps["18"]) / 1000; // Convert to actual amps
    deviceData.current.push(currentValue);
    point.floatField("current", currentValue);
    dataUpdated = true;
  }

  if (dataUpdated) {
    deviceData.lastUpdated = new Date(now);

    // Log the latest values
    logger.debug(`Tuya energy data update`, {
      deviceId: config.id,
      deviceName: config.deviceName,
      power: dps["19"] !== undefined ? Number(dps["19"]) / 10 : "unchanged",
      voltage: dps["20"] !== undefined ? Number(dps["20"]) / 10 : "unchanged",
      current: dps["18"] !== undefined ? Number(dps["18"]) / 1000 : "unchanged",
    });

    // Write to InfluxDB if any value was updated
    influxWriteApi.writePoint(point);
  }
}

function startDevicePolling(config: TuyaDeviceConfig): void {
  const connection = deviceConnections.get(config.id);
  if (!connection) return;

  let pollTimeout: NodeJS.Timeout;
  let isPolling = false;

  const doPoll = async () => {
    if (!connection.connected || isPolling) return;

    isPolling = true;
    try {
      // Create a promise that rejects after POLL_TIMEOUT ms
      const timeoutPromise = new Promise<never>((_, reject) => {
        pollTimeout = setTimeout(() => {
          reject(new Error("Device poll timeout"));
        }, POLL_TIMEOUT);
      });

      // Race between the device refresh and the timeout
      await Promise.race([
        connection.device.refresh({ requestedDPS: [18, 19, 20] }),
        timeoutPromise,
      ]);

      clearTimeout(pollTimeout);
    } catch (error) {
      logger.error("Error polling device", {
        deviceId: config.id,
        deviceName: config.deviceName,
        error: (error as Error).message,
      });

      // If it's a timeout or other communication error, trigger reconnection
      if (
        (error as any).message === "Device poll timeout" ||
        (error as any).message.includes("ETIMEDOUT") ||
        (error as any).message.includes("ECONNRESET")
      ) {
        connection.connected = false;
        scheduleReconnect(config);
      }
    } finally {
      isPolling = false;
    }
  };

  // Start polling loop
  setInterval(doPoll, POLL_INTERVAL);
}

async function disconnectDevice(deviceId: string): Promise<void> {
  const connection = deviceConnections.get(deviceId);
  if (connection) {
    if (connection.reconnectTimeout) {
      clearTimeout(connection.reconnectTimeout);
    }
    try {
      connection.device.disconnect();
    } catch (error) {
      logger.error("Error disconnecting device", {
        deviceId,
        error: (error as Error).message,
      });
    }
    deviceConnections.delete(deviceId);
    tuyaDeviceData.delete(deviceId);
  }
}

async function disconnectAllDevices(): Promise<void> {
  for (const [deviceId] of deviceConnections) {
    await disconnectDevice(deviceId);
  }
}

export function aggregateTuyaData(): void {
  const now = new Date();
  const timestamp = new Date(now.setSeconds(0, 0));
  const intervalStart = new Date(timestamp.getTime() - 15 * 60 * 1000); // 15 minutes ago

  for (const [deviceId, deviceData] of tuyaDeviceData.entries()) {
    const config = getConfig().tuyaDevices.find((d) => d.id === deviceId);
    if (!config) continue;

    // Calculate time-weighted average power and energy consumption
    let totalEnergy = 0;
    let totalVoltageSum = 0;
    let totalCurrentSum = 0;

    // Process power readings
    const powerReadings = deviceData.power;
    if (powerReadings.length > 0) {
      for (let i = 0; i < powerReadings.length; i++) {
        const reading = powerReadings[i];
        const nextReading = powerReadings[i + 1];

        // Calculate duration for this power reading
        let duration;
        if (nextReading) {
          duration = (nextReading.timestamp - reading.timestamp) / 1000; // convert to seconds
        } else {
          // For the last reading, use time until end of interval or now
          duration = (now.getTime() - reading.timestamp) / 1000;
        }

        // Calculate energy for this period (Wh)
        totalEnergy += (reading.value * duration) / 3600; // convert W*s to Wh
      }
    }

    // Calculate simple averages for voltage and current
    if (deviceData.voltage.length > 0) {
      totalVoltageSum = deviceData.voltage.reduce((a, b) => a + b, 0);
    }
    if (deviceData.current.length > 0) {
      totalCurrentSum = deviceData.current.reduce((a, b) => a + b, 0);
    }

    const avgVoltage =
      deviceData.voltage.length > 0
        ? totalVoltageSum / deviceData.voltage.length
        : 0;
    const avgCurrent =
      deviceData.current.length > 0
        ? totalCurrentSum / deviceData.current.length
        : 0;

    // Write aggregated data point
    const point = new Point("aggregated_energy")
      .tag("device", config.deviceName)
      .floatField("consumption", totalEnergy)
      .floatField("avg_voltage", avgVoltage)
      .floatField("avg_current", avgCurrent)
      .timestamp(timestamp);

    influxWriteApi.writePoint(point);

    logger.info("Aggregated Tuya device data", {
      deviceName: config.deviceName,
      energyConsumption: totalEnergy,
      avgVoltage,
      avgCurrent,
      readingsCount: powerReadings.length,
    });

    // Reset arrays for next interval
    deviceData.power = [];
    deviceData.voltage = [];
    deviceData.current = [];
  }
}
