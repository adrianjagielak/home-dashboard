import axios from "axios";
import { parse, isSameDay } from "date-fns";
import winston from "winston";
import { Holiday } from "./holiday-model";

export class HolidayService {
  private holidays: Map<number, Holiday[]> = new Map();
  private logger: winston.Logger;

  constructor(logger: winston.Logger) {
    this.logger = logger;
  }

  async ensureHolidaysForYear(year: number): Promise<void> {
    if (!this.holidays.has(year)) {
      try {
        const response = await axios.get<Holiday[]>(
          `https://date.nager.at/api/v3/PublicHolidays/${year}/PL`,
        );
        this.holidays.set(year, response.data);
        this.logger.info(`Fetched holidays for year ${year}`);
      } catch (error) {
        this.logger.error(`Failed to fetch holidays for year ${year}`, {
          error,
        });
        this.holidays.set(year, []); // Set empty array to prevent repeated failed requests
      }
    }
  }

  async isHoliday(date: Date): Promise<boolean> {
    const year = date.getFullYear();
    await this.ensureHolidaysForYear(year);

    const yearHolidays = this.holidays.get(year) || [];
    return yearHolidays.some((holiday) =>
      isSameDay(date, parse(holiday.date, "yyyy-MM-dd", new Date())),
    );
  }
}
