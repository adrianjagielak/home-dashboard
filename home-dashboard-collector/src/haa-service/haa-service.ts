import { Point, WriteApi } from "@influxdata/influxdb-client";
import winston from "winston";
import { Request, Response } from "express";
import { AppConfig } from "../config-model";

interface DeviceData {
  voltage: number[];
  current: number[];
  consumption: number;
  lastConsumption: number;
}

let deviceData: Record<string, DeviceData> = {};
let influxWriteApi: WriteApi;
let logger: winston.Logger;
let getConfig: () => AppConfig;

export function initHAAService(
  writeApi: WriteApi,
  log: winston.Logger,
  configGetter: () => AppConfig,
) {
  influxWriteApi = writeApi;
  logger = log;
  getConfig = configGetter;
  deviceData = {};

  logger.info("HAA service initialized");
}

export function handleHAAEnergyData(req: Request, res: Response) {
  try {
    if (typeof req.body !== "string") {
      throw new Error("Request body is not a string.");
    }

    const [deviceId, voltage, current, power, consumption] = req.body
      .split(",")
      .map((value, index) => {
        if (index === 0) return value; // deviceId as string
        return parseFloat(value); // other fields as numbers
      });

    const deviceName = getConfig().devices?.[deviceId] || `unknown_${deviceId}`;
    // Convert kWh to Wh
    const consumptionValue = (consumption as number) * 1000;

    if (!deviceData[deviceId]) {
      deviceData[deviceId] = {
        voltage: [],
        current: [],
        consumption: 0,
        lastConsumption: consumptionValue,
      };
    }

    const device = deviceData[deviceId];

    // Update voltage and current arrays
    device.voltage.push(voltage as number);
    device.current.push(current as number);

    // Update consumption only if it increases
    if (consumptionValue >= device.lastConsumption) {
      device.consumption += consumptionValue - device.lastConsumption;
      device.lastConsumption = consumptionValue;
    }

    device.lastConsumption = consumptionValue;

    // Write raw event to InfluxDB
    const point = new Point("raw_energy")
      .tag("device", deviceName)
      .floatField("voltage", voltage as number)
      .floatField("current", current as number)
      .floatField("power", power as number)
      .floatField("total_consumption", consumptionValue);

    influxWriteApi.writePoint(point);
    logger.debug(`HAA energy data received`, {
      deviceId,
      voltage,
      current,
      power,
      consumption,
    });

    res.status(200).send("Data collected successfully.");
  } catch (error) {
    logger.error("Error processing HAA energy data", { error });
    res.status(400).send("Invalid data format.");
  }
}

export function aggregateHAAData() {
  const now = new Date();
  const timestamp = new Date(now.setSeconds(0, 0));

  for (const [deviceId, data] of Object.entries(deviceData)) {
    const deviceName = getConfig().devices?.[deviceId] || `unknown_${deviceId}`;
    const avgVoltage =
      data.voltage.reduce((a, b) => a + b, 0) / data.voltage.length || 0;
    const avgCurrent =
      data.current.reduce((a, b) => a + b, 0) / data.current.length || 0;
    const consumption = data.consumption;

    // Write aggregated data to InfluxDB
    const point = new Point("aggregated_energy")
      .tag("device", deviceName)
      .floatField("avg_voltage", avgVoltage)
      .floatField("avg_current", avgCurrent)
      .floatField("consumption", consumption)
      .timestamp(timestamp);

    influxWriteApi.writePoint(point);
    logger.info("Aggregated HAA data written to InfluxDB", {
      deviceId,
      avgVoltage,
      avgCurrent,
      consumption,
    });

    // Reset the data for the next interval
    data.voltage = [];
    data.current = [];
    data.consumption = 0;
  }
}
