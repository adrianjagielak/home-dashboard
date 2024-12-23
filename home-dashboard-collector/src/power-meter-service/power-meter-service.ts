import axios from "axios";
import { Point, QueryApi, WriteApi } from "@influxdata/influxdb-client";
import winston from "winston";
import { subDays, startOfDay, addHours, isBefore } from "date-fns";
import { AppConfig } from "../config-model";

function randomDelay(min: number = 500, max: number = 1000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

interface EnergyReading {
  timestamp: number;
  value: number;
}

let getConfig: () => AppConfig;
let influxQueryApi: QueryApi;
let influxWriteApi: WriteApi;
let logger: winston.Logger;
let sessionCookies: string[] = [];

export function initPowerMeterService(
  queryApi: QueryApi,
  writeApi: WriteApi,
  log: winston.Logger,
  configGetter: () => AppConfig,
) {
  if (
    !configGetter().powerMeter.username ||
    !configGetter().powerMeter.password ||
    !configGetter().powerMeter.meterId
  ) {
    throw new Error("Power meter configuration is incomplete");
  }

  getConfig = configGetter;
  influxQueryApi = queryApi;
  influxWriteApi = writeApi;
  logger = log;

  setupAxiosDebugLogging(logger);
  logger.info("Power meter service initialized");
}

async function loginToPowerMeter(): Promise<void> {
  try {
    logger.debug("Attempting power meter pre-login...");
    await randomDelay();
    const preLoginResponse = await axios.get(
      "https://api-mojlicznik.energa-operator.pl/dp/apihelper/SessionStatus",
    );
    if (!preLoginResponse.data.success) {
      throw new Error("Pre-login failed.");
    }
    sessionCookies = preLoginResponse.headers["set-cookie"] || [];

    logger.debug("Attempting power meter login...");
    await randomDelay();
    const loginResponse = await axios.get(
      `https://api-mojlicznik.energa-operator.pl/dp/apihelper/UserLogin`,
      {
        params: {
          clientOS: "ios",
          notifyService: "APNs",
          password: getConfig().powerMeter.password,
          token:
            "491ab71447c72d9b9c2ec3c4c277af5d7e69794de8bf49b2e574b6b5df5b79c0",
          username: getConfig().powerMeter.username,
        },
        headers: { Cookie: sessionCookies.join("; ") },
      },
    );
    if (!loginResponse.data.success) {
      throw new Error("Login failed.");
    }
    sessionCookies = loginResponse.headers["set-cookie"] || [];
    logger.info("Power meter login successful.");
  } catch (error) {
    logger.error("Error during power meter login.", { error });
    throw error;
  }
}

async function fetchDailyData(timestamp: number): Promise<EnergyReading[]> {
  try {
    logger.debug("Fetching daily power meter data...", { timestamp });
    await randomDelay();
    const response = await axios.get(
      "https://api-mojlicznik.energa-operator.pl/dp/resources/mchart",
      {
        params: {
          mainChartDate: timestamp,
          meterPoint: getConfig().powerMeter.meterId,
          type: "DAY",
        },
        headers: { Cookie: sessionCookies.join("; ") },
      },
    );

    if (!response.data.success) {
      throw new Error("Failed to fetch power meter data.");
    }

    const readings = response.data.response.mainChart
      .map((entry: any) => ({
        timestamp: parseInt(entry.tm, 10),
        value:
          entry.zones.reduce(
            (sum: number, zone: number | null) => sum + (zone || 0),
            0,
          ) * 1000, // Convert kWh to Wh
      }))
      .filter((reading: EnergyReading) => reading.value > 0); // Filter out zero or invalid readings

    logger.debug("Processed daily readings", {
      readingsCount: readings.length,
      firstReading: readings[0],
      lastReading: readings[readings.length - 1],
    });

    return readings;
  } catch (error) {
    logger.error("Error fetching daily power meter data.", { error });
    throw error;
  }
}

async function getLastSavedReading(): Promise<Date> {
  try {
    const query = `
      from(bucket: "${getConfig().influxdb.bucket}")
        |> range(start: -30d)
        |> filter(fn: (r) => r["_measurement"] == "raw_power_meter")
        |> last()
    `;

    const result: any[] = [];
    return new Promise<Date>((resolve, reject) => {
      influxQueryApi.queryRows(query, {
        next: (row: any, tableMeta: any) => {
          result.push(tableMeta.toObject(row));
        },
        error: (error: Error) => {
          reject(error);
        },
        complete: () => {
          if (result.length > 0) {
            resolve(new Date(result[0]._time));
          } else {
            resolve(startOfDay(subDays(new Date(), 30)));
          }
        },
      });
    }).catch((error) => {
      logger.error("Error getting last saved reading", { error });
      return startOfDay(subDays(new Date(), 30));
    });
  } catch (error) {
    logger.error("Error getting last saved reading", { error });
    return startOfDay(subDays(new Date(), 30));
  }
}

async function getDeviceConsumption(
  startTime: Date,
  endTime: Date,
): Promise<number> {
  try {
    const config = getConfig();
    // Format the dates properly for Flux
    const query = `
      from(bucket: "${config.influxdb.bucket}")
        |> range(start: ${startTime.toISOString()}, stop: ${endTime.toISOString()})
        |> filter(fn: (r) => r._measurement == "aggregated_energy")
        |> filter(fn: (r) => r._field == "consumption")
        |> filter(fn: (r) => r.device != "other")
        |> sum()
    `;

    let totalConsumption = 0;
    return new Promise<number>((resolve, reject) => {
      influxQueryApi.queryRows(query, {
        next: (row: any, tableMeta: any) => {
          const result = tableMeta.toObject(row);
          totalConsumption += result._value || 0;
        },
        error: (error: Error) => {
          reject(error);
        },
        complete: () => {
          resolve(totalConsumption);
        },
      });
    }).catch((error) => {
      logger.error("Error getting device consumption", { error });
      return 0;
    });
  } catch (error) {
    logger.error("Error getting device consumption", { error });
    return 0;
  }
}

async function processAndStoreData(readings: EnergyReading[]): Promise<void> {
  for (const reading of readings) {
    // Store raw power meter reading
    const rawPoint = new Point("raw_power_meter")
      .floatField("value", reading.value)
      .timestamp(new Date(reading.timestamp));
    influxWriteApi.writePoint(rawPoint);

    // Add 15 minutes (900000 milliseconds) to align the timestamps
    const readingTime = new Date(reading.timestamp + 900000);
    const nextHour = addHours(readingTime, 1);

    // Calculate and store "other" consumption
    const deviceConsumption = await getDeviceConsumption(readingTime, nextHour);
    const otherConsumption = Math.max(0, reading.value - deviceConsumption);
    const quarterHourConsumption = otherConsumption / 4;

    // Store four 15-minute readings for "other" consumption
    for (let i = 0; i < 4; i++) {
      const timestamp = addHours(readingTime, i * 0.25);
      const aggregatedPoint = new Point("aggregated_energy")
        .tag("device", "other")
        .floatField("consumption", quarterHourConsumption)
        .timestamp(timestamp);
      influxWriteApi.writePoint(aggregatedPoint);
    }

    logger.info("Stored power meter readings", {
      ts: readingTime,
      totalValue: reading.value,
      deviceConsumption,
      otherConsumption,
      quarterHourConsumption,
    });
  }
}

export async function updatePowerMeterData(): Promise<void> {
  try {
    const lastReading = await getLastSavedReading();
    const now = new Date();
    let currentDate = startOfDay(lastReading);

    await loginToPowerMeter();

    while (isBefore(currentDate, now)) {
      const readings = await fetchDailyData(currentDate.getTime());
      const validReadings = readings
        .filter((reading) => reading.timestamp > lastReading.getTime())
        .sort((a, b) => a.timestamp - b.timestamp);

      if (validReadings.length > 0) {
        await processAndStoreData(validReadings);
        logger.info("Processed readings for date", {
          date: currentDate,
          readingsCount: validReadings.length,
          firstReading: new Date(validReadings[0].timestamp),
          lastReading: new Date(
            validReadings[validReadings.length - 1].timestamp,
          ),
        });
      } else {
        logger.debug("No valid readings found for date", { date: currentDate });
      }

      currentDate = addHours(currentDate, 24);
    }

    logger.info("Power meter data update completed");
  } catch (error) {
    logger.error("Failed to update power meter data", { error });
  }
}
