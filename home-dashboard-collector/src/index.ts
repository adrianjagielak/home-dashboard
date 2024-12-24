import express from "express";
import bodyParser from "body-parser";
import fs from "fs/promises";
import yaml from "js-yaml";
import { InfluxDB, QueryApi, WriteApi } from "@influxdata/influxdb-client";
import readline from "readline";
import winston from "winston";
import cron from "node-cron";
import {
  initHAAService,
  handleHAAEnergyData,
  aggregateHAAData,
} from "./haa-service/haa-service";
import {
  initPowerMeterService,
  updatePowerMeterData,
} from "./power-meter-service/power-meter-service";
import {
  initPriceService,
  performInitialPricesUpdate,
  updatePrices,
} from "./price-service/price-service";

import { AppConfig } from "./config-model";
import axios from "axios";

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

function setupAxiosDebugLogging(logger: winston.Logger) {
  axios.interceptors.request.use(
    (config) => {
      logger.debug("Axios Request:", {
        method: config.method?.toUpperCase(),
        url: config.url,
        params: config.params,
        headers: {
          ...config.headers,
          Cookie: "(hidden)",
        },
      });
      return config;
    },
    (error) => {
      logger.debug("Axios Request Error:", { error: error.message });
      return Promise.reject(error);
    },
  );

  axios.interceptors.response.use(
    (response) => {
      logger.debug("Axios Response:", {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...response.headers,
          "set-cookie": "(hidden)",
        },
        data: response.data,
      });
      return response;
    },
    (error) => {
      logger.debug("Axios Response Error:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        error: error.message,
      });
      return Promise.reject(error);
    },
  );
}

// Configuration
let config: AppConfig = {} as any;
const configFilePath = "./config.yaml";

async function loadConfig() {
  try {
    const data = await fs.readFile(configFilePath, "utf-8");
    config = yaml.load(data) as any;
    logger.info("Configuration loaded successfully");
  } catch (error) {
    logger.error("Failed to load configuration", { error });
    config = {} as any;
  }
}

// InfluxDB setup
let influxDB: InfluxDB;
let queryApi: QueryApi;
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
    queryApi = influxDB.getQueryApi(influxdb.org);
    writeApi = influxDB.getWriteApi(influxdb.org, influxdb.bucket);
    writeApi.useDefaultTags({ project: "home_dashboard" });

    logger.info("InfluxDB setup completed.");
  } catch (error) {
    logger.error("Failed to setup InfluxDB", { error });
    process.exit(1);
  }
}

app.post(
  "/collect/haa-energy",
  bodyParser.text({ type: "*/*" }),
  handleHAAEnergyData,
);

// CLI for refreshing configuration
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("line", async (input) => {
  if (input.trim() === "r") {
    await loadConfig();
  }
});

// Start the server
app.listen(port, async () => {
  await loadConfig();
  setupAxiosDebugLogging(logger);
  await setupInfluxDB();

  initHAAService(writeApi, logger, () => config);
  initPowerMeterService(queryApi, writeApi, logger, () => config);
  initPriceService(queryApi, writeApi, logger, () => config);

  await updatePowerMeterData();
  await performInitialPricesUpdate();

  // Aggregate HAA data on every 15th minute
  cron.schedule("*/15 * * * *", () => aggregateHAAData());
  // Try to update power meter data on 5th and 35th minute
  cron.schedule("5,35 * * * *", () => updatePowerMeterData());
  // Fetch the latest upcoming energy prices on 5th minute of every hour
  cron.schedule("5 * * * *", () => updatePrices());

  logger.info(`Home Dashboard Collector & Aggregator running on :${port}`);
  logger.info('Type "r" and press Enter to reload the configuration');
});
