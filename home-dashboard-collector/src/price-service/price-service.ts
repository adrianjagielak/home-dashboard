import axios from "axios";
import { Point, QueryApi, WriteApi } from "@influxdata/influxdb-client";
import winston from "winston";
import {
  addDays,
  addHours,
  format,
  parseISO,
  subDays,
  startOfDay,
  addMinutes,
} from "date-fns";
import { TariffType, TGEPrice } from "./price-model";
import { HolidayService } from "../holiday-service/holiday-service";
import { AppConfig } from "../config-model";

let influxQueryApi: QueryApi;
let influxWriteApi: WriteApi;
let logger: winston.Logger;
let getConfig: () => AppConfig;
let holidayService: HolidayService;

export function initPriceService(
  queryApi: QueryApi,
  writeApi: WriteApi,
  log: winston.Logger,
  configGetter: () => AppConfig,
) {
  influxQueryApi = queryApi;
  influxWriteApi = writeApi;
  logger = log;
  getConfig = configGetter;
  holidayService = new HolidayService(logger);

  logger.info("Price service initialized");
}

async function getLastSavedPrice(): Promise<Date> {
  try {
    const query = `
      from(bucket: "${getConfig().influxdb.bucket}")
        |> range(start: -30d)
        |> filter(fn: (r) => r["_measurement"] == "energy_prices")
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
      logger.error("Error getting last saved price", {
        error: error.message,
        stack: error.stack,
      });
      return startOfDay(subDays(new Date(), 30));
    });
  } catch (error) {
    const err = error as Error;
    logger.error("Error in getLastSavedPrice", {
      error: err.message,
      stack: err.stack,
    });
    return startOfDay(subDays(new Date(), 30));
  }
}

export async function performInitialPricesUpdate(): Promise<void> {
  try {
    const lastSavedPrice = await getLastSavedPrice();
    const now = new Date();
    let currentDate = startOfDay(lastSavedPrice);

    logger.info("Performing initial price update...", {
      from: currentDate,
      to: now,
    });

    while (currentDate <= now) {
      const endDate = addDays(currentDate, 1);
      const tgePrices = await fetchTGEPrices(currentDate, endDate);
      await storePrices(currentDate, endDate, tgePrices);
      currentDate = endDate;

      // Add a small delay to avoid overwhelming the TGE API
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logger.info("Initial price update completed");
  } catch (error) {
    const err = error as Error;
    logger.error("Error during initial price update", {
      error: err.message,
      stack: err.stack,
    });
  }
}

async function fetchTGEPrices(
  dateFrom: Date,
  dateTo: Date,
): Promise<TGEPrice[]> {
  try {
    const formatDate = (date: Date) => format(date, "dd-MM-yyyy'T'HH:mm:ss'Z'");
    const url = `https://energy-instrat-api.azurewebsites.net/api/prices/energy_price_rdn_hourly`;

    const response = await axios.get(url, {
      params: {
        date_from: formatDate(dateFrom),
        date_to: formatDate(dateTo),
      },
    });

    return response.data;
  } catch (error) {
    const err = error as Error;
    logger.error("Error fetching TGE prices", {
      error: err.message,
      stack: err.stack,
    });
    return [];
  }
}

async function isHoliday(date: Date): Promise<boolean> {
  return await holidayService.isHoliday(date);
}

async function isPeakHour(
  date: Date,
  tariffType: TariffType,
): Promise<boolean> {
  const hour = date.getHours();
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;

  switch (tariffType) {
    case TariffType.G12:
    case TariffType.G12W:
    case TariffType.DYNAMIC_G12:
    case TariffType.DYNAMIC_G12W:
      if (
        tariffType === TariffType.G12W ||
        tariffType === TariffType.DYNAMIC_G12W
      ) {
        if (isWeekend || (await isHoliday(date))) return false;
      }
      return (hour >= 6 && hour < 13) || (hour >= 15 && hour < 22);

    case TariffType.G12R:
    case TariffType.DYNAMIC_G12R:
      return (hour >= 7 && hour < 13) || (hour >= 16 && hour < 22);

    default:
      return true;
  }
}

async function calculatePrice(
  date: Date,
  tariffType: TariffType,
  tgePrice?: number,
): Promise<number | null> {
  if (tariffType === TariffType.TGE_RAW) {
    return tgePrice ? tgePrice / 1000 : null;
  }

  const isPeak = await isPeakHour(date, tariffType);
  const priceConfig = getConfig().prices;

  // Handle dynamic tariffs
  if (tariffType.startsWith("DYNAMIC_")) {
    if (!tgePrice) return null;

    const basePrice = tgePrice / 1000; // Convert from PLN/MWh to PLN/kWh
    const tariff = tariffType
      .toLowerCase()
      .slice(8) as keyof typeof priceConfig.dynamicTariffs;
    const components = priceConfig.dynamicTariffs[tariff];

    // For G11, components is DynamicTariffComponents
    // For others, components is { peak: DynamicTariffComponents, offPeak: DynamicTariffComponents }
    if ("peak" in components) {
      const tariffComponents = isPeak ? components.peak : components.offPeak;
      const totalPrice =
        (basePrice +
          tariffComponents.oplataSieciowa +
          tariffComponents.oplataJakosciowa +
          tariffComponents.oplataKogeneracyjna) *
          (1 + tariffComponents.vat) +
        tariffComponents.oplataHandlowa;

      return totalPrice;
    } else {
      // G11 case
      const totalPrice =
        (basePrice +
          components.oplataSieciowa +
          components.oplataJakosciowa +
          components.oplataKogeneracyjna) *
          (1 + components.vat) +
        components.oplataHandlowa;

      return totalPrice;
    }
  }

  // Handle static tariffs
  const tariff =
    tariffType.toLowerCase() as keyof typeof priceConfig.staticTariffs;
  const components = priceConfig.staticTariffs[tariff];

  if ("peak" in components) {
    const tariffComponents = isPeak ? components.peak : components.offPeak;
    return (
      (tariffComponents.basePrice +
        tariffComponents.akcyza +
        tariffComponents.oplataSieciowa +
        tariffComponents.oplataJakosciowa +
        tariffComponents.oplataKogeneracyjna) *
      (1 + tariffComponents.vat)
    );
  }

  return (
    (components.basePrice +
      components.akcyza +
      components.oplataSieciowa +
      components.oplataJakosciowa +
      components.oplataKogeneracyjna) *
    (1 + components.vat)
  );
}

async function storePrices(
  startDate: Date,
  endDate: Date,
  tgePrices: TGEPrice[],
): Promise<void> {
  try {
    logger.debug("Storing prices", {
      startDate,
      endDate,
      tgePricesCount: tgePrices.length,
    });

    const tgePriceMap = new Map(
      tgePrices.map((p) => [p.date, p.fixing_i.price]),
    );

    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const exactTimestamp = format(currentDate, "yyyy-MM-dd'T'HH:mm:ss'Z'");
      const hourStart = new Date(currentDate);
      hourStart.setMinutes(0, 0, 0);
      const hourlyTimestamp = format(hourStart, "yyyy-MM-dd'T'HH:mm:ss'Z'");

      const tgePrice =
        tgePriceMap.get(exactTimestamp) ?? tgePriceMap.get(hourlyTimestamp);

      logger.debug("Processing interval", {
        currentDate,
        tgePrice,
        using15MinPrice: tgePriceMap.has(exactTimestamp),
      });

      await Promise.all(
        Object.values(TariffType).map(async (tariffType) => {
          try {
            const price = await calculatePrice(
              currentDate,
              tariffType,
              tgePrice,
            );

            // Only store the point if we got a valid price
            if (price !== null) {
              const point = new Point("energy_prices")
                .tag("tariff", tariffType)
                .floatField("price", price)
                .timestamp(currentDate);

              influxWriteApi.writePoint(point);

              logger.debug("Price point stored", {
                date: currentDate,
                tariff: tariffType,
                price,
              });
            } else {
              logger.debug("Skipping interval due to missing TGE price", {
                date: currentDate,
                tariff: tariffType,
              });
            }
          } catch (error) {
            const err = error as Error;
            logger.error("Error calculating/storing price for tariff", {
              error: err.message,
              stack: err.stack,
              tariff: tariffType,
              date: currentDate,
            });
          }
        }),
      );

      currentDate = addMinutes(currentDate, 15);
    }
  } catch (error) {
    const err = error as Error;
    logger.error("Error in storePrices", {
      error: err.message,
      stack: err.stack,
      startDate,
      endDate,
    });
    throw error;
  }
}

export async function updatePrices(): Promise<void> {
  try {
    const now = new Date();
    const tomorrow = addDays(now, 1);

    // Fetch TGE prices for dynamic tariffs
    const tgePrices = await fetchTGEPrices(now, tomorrow);

    // Store prices for all tariffs
    await storePrices(now, tomorrow, tgePrices);

    logger.info("Price update completed");
  } catch (error) {
    const err = error as Error;
    logger.error("Error updating prices", {
      error: err.message,
      stack: err.stack,
    });
  }
}
