export interface BaseTariffComponents {
  basePrice: number;
  akcyza: number;
  oplataSieciowa: number;
  oplataJakosciowa: number;
  oplataKogeneracyjna: number;
  vat: number;
}

export interface DynamicTariffComponents {
  oplataSieciowa: number;
  oplataJakosciowa: number;
  oplataKogeneracyjna: number;
  oplataHandlowa: number;
  vat: number;
}

export interface TGEPrice {
  date: string;
  fixing_i: {
    price: number;
    volume: number;
  };
  fixing_ii: {
    price: number;
    volume: number;
  };
}

export enum TariffType {
  G11 = "G11",
  G12 = "G12",
  G12W = "G12W",
  G12R = "G12R",
  DYNAMIC_G11 = "DYNAMIC_G11",
  DYNAMIC_G12 = "DYNAMIC_G12",
  DYNAMIC_G12W = "DYNAMIC_G12W",
  DYNAMIC_G12R = "DYNAMIC_G12R",
  TGE_RAW = "TGE_RAW",
}

export interface PriceConfig {
  staticTariffs: {
    g11: BaseTariffComponents;
    g12: {
      peak: BaseTariffComponents;
      offPeak: BaseTariffComponents;
    };
    g12w: {
      peak: BaseTariffComponents;
      offPeak: BaseTariffComponents;
    };
    g12r: {
      peak: BaseTariffComponents;
      offPeak: BaseTariffComponents;
    };
  };
  dynamicTariffs: {
    g11: DynamicTariffComponents;
    g12: {
      peak: DynamicTariffComponents;
      offPeak: DynamicTariffComponents;
    };
    g12w: {
      peak: DynamicTariffComponents;
      offPeak: DynamicTariffComponents;
    };
    g12r: {
      peak: DynamicTariffComponents;
      offPeak: DynamicTariffComponents;
    };
  };
}
