import TuyAPI from "tuyapi";

export interface TuyaDeviceData {
  power: Array<{
    value: number;
    timestamp: number;
  }>;
  voltage: number[];
  current: number[];
  lastUpdated: Date;
}

export interface TuyaDeviceConnection {
  device: TuyAPI;
  connected: boolean;
  lastError?: Error;
  backoffDelay: number;
  reconnectTimeout?: NodeJS.Timeout;
}
