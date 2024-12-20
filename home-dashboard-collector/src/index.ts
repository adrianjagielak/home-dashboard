import express from "express";
import bodyParser from "body-parser";
import fs from "fs/promises";
import yaml from "js-yaml";
import { InfluxDB, Point, WriteApi } from "@influxdata/influxdb-client";
import readline from "readline";
import winston from "winston";
import cron from "node-cron";

const app = express();
const port = 14001;

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
};

const levelColors: Record<string, string> = {
  error: colors.red,
  warn: colors.yellow,
  info: colors.green,
  debug: colors.gray,
};

// Custom formatter with ANSI colors
const consoleFormat = winston.format.printf(
  ({ timestamp, level, message, ...meta }) => {
    const color = levelColors[level] || colors.reset;
    const messageColor = level === "debug" ? colors.gray : colors.white; // Apply gray color to debug messages
    return `${colors.gray}${timestamp}${colors.reset} ${color}[${level.toUpperCase()}]${colors.reset}: ${messageColor}${message}${colors.reset} ${
      Object.keys(meta).length ? JSON.stringify(meta) : ""
    }`;
  },
);

// Logger setup
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ""}`;
    }),
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.timestamp(), consoleFormat),
    }),
  ],
});

// Configuration
let config: Record<string, any> = {};
const configFilePath = "./config.yaml";

async function loadConfig() {
  try {
    const data = await fs.readFile(configFilePath, "utf-8");
    config = yaml.load(data) as any;
    logger.info("Configuration loaded successfully", config);
  } catch (error) {
    logger.error("Failed to load configuration", { error });
    config = {};
  }
}

// InfluxDB setup
let influxDB: InfluxDB;
let writeApi: WriteApi;

async function setupInfluxDB() {
  try {
    const { influxdb } = config;
    if (
      !influxdb ||
      !influxdb.url ||
      !influxdb.token ||
      !influxdb.org ||
      !influxdb.bucket
    ) {
      throw new Error(
        "InfluxDB configuration is incomplete in the config file.",
      );
    }

    influxDB = new InfluxDB({
      url: influxdb.url,
      token: influxdb.token,
    });
    writeApi = influxDB.getWriteApi(influxdb.org, influxdb.bucket);
    writeApi.useDefaultTags({ project: "home_dashboard" });

    logger.info("InfluxDB setup completed.");
  } catch (error) {
    logger.error("Failed to setup InfluxDB", { error });
    process.exit(1);
  }
}

// Data storage for aggregation
const deviceData: Record<
  string,
  {
    voltage: number[];
    current: number[];
    consumption: number;
    lastConsumption: number;
  }
> = {};

// Endpoint for HAA energy data
app.post(
  "/collect/haa-energy",
  bodyParser.text({ type: "*/*" }),
  (req, res) => {
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

      const deviceName = config.devices?.[deviceId] || `unknown_${deviceId}`;
      // Convert kWh to Wh by multiplying by 1000
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

      writeApi.writePoint(point);
      logger.debug(`HAA energy data received`, {
        deviceId,
        voltage,
        current,
        power,
        consumption,
      });

      res.status(200).send("Data collected successfully.");
    } catch (error) {
      logger.error("Error processing /collect/haa-energy request", { error });
      res.status(400).send("Invalid data format.");
    }
  },
);

function aggregateData() {
  const now = new Date();
  const timestamp = new Date(now.setSeconds(0, 0));

  for (const [deviceId, data] of Object.entries(deviceData)) {
    const deviceName = config.devices?.[deviceId] || `unknown_${deviceId}`;
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

    writeApi.writePoint(point);
    logger.info("Aggregated data written to InfluxDB", {
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

// CLI for refreshing configuration
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("line", async (input) => {
  if (input.trim() === "r") {
    await loadConfig();
    logger.info("Configuration reloaded via CLI command.");
  }
});

// Start the server
app.listen(port, async () => {
  await loadConfig();
  await setupInfluxDB();

  // Aggregate data every 15th minute
  cron.schedule("*/15 * * * *", () => {
    aggregateData();
  });

  logger.info(`Collection & Aggregation Service running on port ${port}`);
  logger.info('Type "r" to reload the configuration.');
});
