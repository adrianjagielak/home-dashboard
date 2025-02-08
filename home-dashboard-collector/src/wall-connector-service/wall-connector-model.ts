export interface WallConnectorVitals {
  contactor_closed: boolean;
  vehicle_connected: boolean;
  session_s: number;
  grid_v: number;
  grid_hz: number;
  vehicle_current_a: number;
  currentA_a: number;
  currentB_a: number;
  currentC_a: number;
  currentN_a: number;
  voltageA_v: number;
  voltageB_v: number;
  voltageC_v: number;
  relay_coil_v: number;
  pcba_temp_c: number;
  handle_temp_c: number;
  mcu_temp_c: number;
  uptime_s: number;
  input_thermopile_uv: number;
  prox_v: number;
  pilot_high_v: number;
  pilot_low_v: number;
  session_energy_wh: number;
  config_status: number;
  evse_state: number;
  // TODO: What type?
  current_alerts: any[];
  evse_not_ready_reasons: number[];
}

export interface WallConnectorData {
  readings: Array<{
    timestamp: number;
    current: number;
    voltage: number;
    charging: boolean;
  }>;
}
