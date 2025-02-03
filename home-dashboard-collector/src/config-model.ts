import { PriceConfig } from "./price-service/price-model";

export interface InfluxDBConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
}

export interface PowerMeterConfig {
  username: string;
  password: string;
  meterId: string;
}

export interface HAADevicesConfig {
  [deviceId: string]: string; // mapping of device IDs to names
}

export interface TuyaDeviceConfig {
  id: string;
  localKey: string;
  deviceName: string;
}

export interface WallConnectorConfig {
  ip: string;
}

export interface AppConfig {
  influxdb: InfluxDBConfig;
  powerMeter: PowerMeterConfig;
  devices: HAADevicesConfig;
  prices: PriceConfig;
  tuyaDevices: TuyaDeviceConfig[];
  wallConnector: WallConnectorConfig;
}
