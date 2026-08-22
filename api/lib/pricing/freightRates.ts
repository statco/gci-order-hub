// AUTO-GENERATED from 2026_Drop_Ship_Rate_Tool_CDA_TIRE.xlsx (CT's official drop-ship rate calculator).
// Source: CT_Account Statements / 2026_Drop_Ship_Rate_Tool_CDA_TIRE.xlsx, tabs 'SHIPPING RATES' and 'ALL ZONES'.
// Regenerate this file if CT issues an updated rate tool — do not hand-edit the data below.

export type TireType = 'Passenger' | 'LT';
export type Warehouse = 'Mississauga' | 'ValleyField' | 'Sherbrooke' | 'Levis' | 'Moncton' | 'Dartmouth' | 'Nfld';

export interface RateEntry {
  /** Minimum charge covering a shipment of 1-4 tires, indexed by zone 1-16 (array index 0 = zone 1). */
  min4ByZone: number[];
  /** Additional charge per tire beyond 4, indexed by zone 1-16. */
  perAdditionalByZone: number[];
}

// Keyed as `${TireType}_${rimSize}`.
export const RATE_MATRIX: Record<string, RateEntry> = {
  "Passenger_13": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_14": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_15": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_16": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_17": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_18": {
    "min4ByZone": [
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      22,
      43,
      43,
      43,
      43,
      43,
      63,
      63,
      83
    ],
    "perAdditionalByZone": [
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      5.5,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      15.75,
      15.75,
      20.75
    ]
  },
  "Passenger_19": {
    "min4ByZone": [
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      43,
      43,
      43,
      43,
      43,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "Passenger_20": {
    "min4ByZone": [
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      43,
      43,
      43,
      43,
      43,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "Passenger_21": {
    "min4ByZone": [
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      43,
      43,
      43,
      43,
      43,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "Passenger_22": {
    "min4ByZone": [
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      27,
      43,
      43,
      43,
      43,
      43,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      6.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "LT_13": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      51,
      51,
      51,
      51,
      51,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "LT_14": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      51,
      51,
      51,
      51,
      51,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "LT_15": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      51,
      51,
      51,
      51,
      51,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "LT_16": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      51,
      51,
      51,
      51,
      51,
      83,
      83,
      103
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      20.75,
      20.75,
      25.75
    ]
  },
  "LT_17": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      67,
      67,
      67,
      123,
      123,
      143
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      16.75,
      16.75,
      16.75,
      30.75,
      30.75,
      35.75
    ]
  },
  "LT_18": {
    "min4ByZone": [
      43,
      43,
      43,
      43,
      43,
      43,
      43,
      43,
      51,
      51,
      67,
      67,
      67,
      123,
      123,
      143
    ],
    "perAdditionalByZone": [
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      10.75,
      12.75,
      12.75,
      16.75,
      16.75,
      16.75,
      30.75,
      30.75,
      35.75
    ]
  },
  "LT_19": {
    "min4ByZone": [
      51,
      51,
      51,
      51,
      51,
      51,
      59,
      59,
      59,
      59,
      103,
      103,
      103,
      163,
      163,
      163
    ],
    "perAdditionalByZone": [
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      14.75,
      14.75,
      14.75,
      14.75,
      25.75,
      25.75,
      25.75,
      40.75,
      40.75,
      40.75
    ]
  },
  "LT_20": {
    "min4ByZone": [
      51,
      51,
      51,
      51,
      51,
      51,
      59,
      59,
      59,
      59,
      103,
      103,
      103,
      163,
      163,
      163
    ],
    "perAdditionalByZone": [
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      14.75,
      14.75,
      14.75,
      14.75,
      25.75,
      25.75,
      25.75,
      40.75,
      40.75,
      40.75
    ]
  },
  "LT_21": {
    "min4ByZone": [
      51,
      51,
      51,
      51,
      51,
      51,
      59,
      59,
      59,
      59,
      103,
      103,
      103,
      163,
      163,
      163
    ],
    "perAdditionalByZone": [
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      14.75,
      14.75,
      14.75,
      14.75,
      25.75,
      25.75,
      25.75,
      40.75,
      40.75,
      40.75
    ]
  },
  "LT_22": {
    "min4ByZone": [
      51,
      51,
      51,
      51,
      51,
      51,
      59,
      59,
      59,
      59,
      103,
      103,
      103,
      163,
      163,
      163
    ],
    "perAdditionalByZone": [
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      12.75,
      14.75,
      14.75,
      14.75,
      14.75,
      25.75,
      25.75,
      25.75,
      40.75,
      40.75,
      40.75
    ]
  }
};

export interface FsaZoneRow {
  fsa1: string;
  fsa2: string;
  province: string;
  location: string;
  /** 0 = no rate defined for this warehouse/FSA combo in the source table. */
  zones: Record<Warehouse, number>;
}

export const FSA_ZONE_MAP: FsaZoneRow[] = [
 {
  "fsa1": "H0A",
  "fsa2": "H9X",
  "province": "Quebec",
  "location": "Northern Quebec (remote areas)",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 1,
   "Sherbrooke": 2,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J3V",
  "fsa2": "J5R",
  "province": "Quebec",
  "location": "Saint-Lambert",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 1,
   "Sherbrooke": 2,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J6J",
  "fsa2": "J7W",
  "province": "Quebec",
  "location": "Ch\u00e2teauguay",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 1,
   "Sherbrooke": 2,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K1A",
  "fsa2": "K4P",
  "province": "Ontario",
  "location": "Ottawa (Government of Canada)",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 2,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J8L",
  "fsa2": "J9J",
  "province": "Quebec",
  "location": "Gatineau",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 2,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 13
  }
 },
 {
  "fsa1": "G1A",
  "fsa2": "G3K",
  "province": "Quebec",
  "location": "Quebec City (core)",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 1,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "G6J",
  "fsa2": "G6K",
  "province": "Quebec",
  "location": "Victoriaville",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 1,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "G6V",
  "fsa2": "G7A",
  "province": "Quebec",
  "location": "L\u00e9vis",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 1,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J0J",
  "fsa2": "J0L",
  "province": "Quebec",
  "location": "Monteregie (rural SE of Montreal)",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J0N",
  "fsa2": "J0S",
  "province": "Quebec",
  "location": "Laurentides (rural north of Montreal)",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J1A",
  "fsa2": "J3T",
  "province": "Quebec",
  "location": "Sherbrooke (area)",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J5T",
  "fsa2": "J6E",
  "province": "Quebec",
  "location": "Repentigny",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "J7X",
  "fsa2": "J8H",
  "province": "Quebec",
  "location": "Mirabel",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 2,
   "Sherbrooke": 2,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L0A",
  "fsa2": "L0B",
  "province": "Ontario",
  "location": "Port Hope",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L0H",
  "fsa2": "L0J",
  "province": "Ontario",
  "location": "Uxbridge",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L3P",
  "fsa2": "L3T",
  "province": "Ontario",
  "location": "Markham",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L3X",
  "fsa2": "L3Y",
  "province": "Ontario",
  "location": "Newmarket",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L4A",
  "fsa2": "L4L",
  "province": "Ontario",
  "location": "Stouffville",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L4S",
  "fsa2": "L7K",
  "province": "Ontario",
  "location": "Richmond Hill",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9E",
  "fsa2": "L9E",
  "province": "Ontario",
  "location": "East Gwillimbury",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9W",
  "fsa2": "L9W",
  "province": "Ontario",
  "location": "Orangeville",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "M1B",
  "fsa2": "M9W",
  "province": "Ontario",
  "location": "Scarborough (Toronto)",
  "zones": {
   "Mississauga": 1,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "G0A",
  "fsa2": "G0A",
  "province": "Quebec",
  "location": "C\u00f4te-de-Beaupr\u00e9 / Charlevoix",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G0M",
  "fsa2": "G0P",
  "province": "Quebec",
  "location": "Beauce area (Chaudi\u00e8re-Appalaches)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G0S",
  "fsa2": "G0S",
  "province": "Quebec",
  "location": "Lotbini\u00e8re / Beauce region",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G0X",
  "fsa2": "G0Z",
  "province": "Quebec",
  "location": "Mauricie region",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G3L",
  "fsa2": "G4A",
  "province": "Quebec",
  "location": "Saint-Raymond (Portneuf area)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G5A",
  "fsa2": "G5A",
  "province": "Quebec",
  "location": "La Malbaie (Charlevoix)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G5V",
  "fsa2": "G6H",
  "province": "Quebec",
  "location": "Montmagny",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G6L",
  "fsa2": "G6T",
  "province": "Quebec",
  "location": "Thetford Mines",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G7B",
  "fsa2": "G8N",
  "province": "Quebec",
  "location": "Chicoutimi (Saguenay)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G8T",
  "fsa2": "G9X",
  "province": "Quebec",
  "location": "Trois-Rivi\u00e8res",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "J0A",
  "fsa2": "J0H",
  "province": "Quebec",
  "location": "Centre-du-Qu\u00e9bec (Drummondville area)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "J0T",
  "fsa2": "J0V",
  "province": "Quebec",
  "location": "Laurentians (Mont-Tremblant / Saint-Sauveur area)",
  "zones": {
   "Mississauga": 6,
   "ValleyField": 3,
   "Sherbrooke": 4,
   "Levis": 2,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "K0K",
  "fsa2": "K0M",
  "province": "Ontario",
  "location": "Prince Edward County",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K7G",
  "fsa2": "K7G",
  "province": "Ontario",
  "location": "Gananoque",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K7K",
  "fsa2": "K7R",
  "province": "Ontario",
  "location": "Kingston",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K8N",
  "fsa2": "K9V",
  "province": "Ontario",
  "location": "Belleville",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L0C",
  "fsa2": "L0C",
  "province": "Ontario",
  "location": "Uxbridge",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L0E",
  "fsa2": "L0G",
  "province": "Ontario",
  "location": "Georgina",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L0K",
  "fsa2": "L0N",
  "province": "Ontario",
  "location": "Orillia",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L0P",
  "fsa2": "L0S",
  "province": "Ontario",
  "location": "Milton",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L1A",
  "fsa2": "L1Z",
  "province": "Ontario",
  "location": "Port Hope",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L2A",
  "fsa2": "L3M",
  "province": "Ontario",
  "location": "Fort Erie",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L3V",
  "fsa2": "L3V",
  "province": "Ontario",
  "location": "Orillia",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L3W",
  "fsa2": "L3W",
  "province": "Ontario",
  "location": "Whitby",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L3Z",
  "fsa2": "L3Z",
  "province": "Ontario",
  "location": "Bradford",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L4M",
  "fsa2": "L4R",
  "province": "Ontario",
  "location": "Barrie",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L7L",
  "fsa2": "L9C",
  "province": "Ontario",
  "location": "Burlington",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9G",
  "fsa2": "L9H",
  "province": "Ontario",
  "location": "Ancaster",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9J",
  "fsa2": "L9J",
  "province": "Ontario",
  "location": "Barrie",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L9K",
  "fsa2": "L9K",
  "province": "Ontario",
  "location": "Hamilton",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9L",
  "fsa2": "L9L",
  "province": "Ontario",
  "location": "Port Perry",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "L9M",
  "fsa2": "L9V",
  "province": "Ontario",
  "location": "Penetanguishene",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "L9X",
  "fsa2": "L9Z",
  "province": "Ontario",
  "location": "Springwater",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "N0A",
  "fsa2": "N0A",
  "province": "Ontario",
  "location": "Haldimand County",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N0C",
  "fsa2": "N0C",
  "province": "Ontario",
  "location": "Grey Highlands",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "N0G",
  "fsa2": "N0H",
  "province": "Ontario",
  "location": "Wellington North",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "N1A",
  "fsa2": "N1A",
  "province": "Ontario",
  "location": "Dunnville",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N4K",
  "fsa2": "N4N",
  "province": "Ontario",
  "location": "Owen Sound",
  "zones": {
   "Mississauga": 2,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 11
  }
 },
 {
  "fsa1": "K0A",
  "fsa2": "K0J",
  "province": "Quebec",
  "location": "Eastern Ontario (bordering QC)",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K4R",
  "fsa2": "K7C",
  "province": "Quebec",
  "location": "Hawkesbury",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K7H",
  "fsa2": "K7H",
  "province": "Quebec",
  "location": "Perth",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "K7S",
  "fsa2": "K8H",
  "province": "Quebec",
  "location": "Arnprior",
  "zones": {
   "Mississauga": 4,
   "ValleyField": 4,
   "Sherbrooke": 4,
   "Levis": 4,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "G0C",
  "fsa2": "G0E",
  "province": "Quebec",
  "location": "Chandler / Gasp\u00e9 Peninsula",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G0J",
  "fsa2": "G0L",
  "province": "Quebec",
  "location": "Matane area",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G0R",
  "fsa2": "G0R",
  "province": "Quebec",
  "location": "L\u00e9vis / Bellechasse area",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G4T",
  "fsa2": "G4X",
  "province": "Quebec",
  "location": "Matane area",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "G5H",
  "fsa2": "G5T",
  "province": "Quebec",
  "location": "Alma",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 4,
   "Sherbrooke": 5,
   "Levis": 3,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 11
  }
 },
 {
  "fsa1": "N0B",
  "fsa2": "N0B",
  "province": "Ontario",
  "location": "Waterloo Region",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N0E",
  "fsa2": "N0E",
  "province": "Ontario",
  "location": "Norfolk County",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N0J",
  "fsa2": "N0K",
  "province": "Ontario",
  "location": "Oxford County",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N1C",
  "fsa2": "N4G",
  "province": "Ontario",
  "location": "Guelph",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N4S",
  "fsa2": "N6P",
  "province": "Ontario",
  "location": "Woodstock",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "P0A",
  "fsa2": "P0G",
  "province": "Ontario",
  "location": "Muskoka / Parry Sound",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 5,
   "Sherbrooke": 6,
   "Levis": 7,
   "Moncton": 10,
   "Dartmouth": 9,
   "Nfld": 10
  }
 },
 {
  "fsa1": "G0B",
  "fsa2": "G0B",
  "province": "Quebec",
  "location": "Magdalen Islands",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G0G",
  "fsa2": "G0H",
  "province": "Quebec",
  "location": "North Coast / Labrador border",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G0T",
  "fsa2": "G0W",
  "province": "Quebec",
  "location": "Charlevoix / C\u00f4te-de-Beaupr\u00e9",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G4R",
  "fsa2": "G4S",
  "province": "Quebec",
  "location": "Rimouski",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G4Z",
  "fsa2": "G4Z",
  "province": "Quebec",
  "location": "Mont-Joli / Sayabec",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G5B",
  "fsa2": "G5C",
  "province": "Quebec",
  "location": "Baie-Comeau",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "G8P",
  "fsa2": "G8P",
  "province": "Quebec",
  "location": "Shawinigan",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "J0M",
  "fsa2": "J0M",
  "province": "Quebec",
  "location": "Northern Quebec (e.g., Chibougamau)",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "J0W",
  "fsa2": "J0Z",
  "province": "Quebec",
  "location": "La Tuque / Saint-Michel-des-Saints",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "J9L",
  "fsa2": "J9Z",
  "province": "Quebec",
  "location": "Mont-Laurier",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 5,
   "Sherbrooke": 7,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "N0L",
  "fsa2": "N0R",
  "province": "Ontario",
  "location": "Middlesex County",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 6,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "N7A",
  "fsa2": "N9Y",
  "province": "Ontario",
  "location": "Goderich",
  "zones": {
   "Mississauga": 3,
   "ValleyField": 6,
   "Sherbrooke": 6,
   "Levis": 6,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 10
  }
 },
 {
  "fsa1": "P1A",
  "fsa2": "P2A",
  "province": "Ontario",
  "location": "North Bay",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 8,
   "Sherbrooke": 8,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "P3A",
  "fsa2": "P3Y",
  "province": "Ontario",
  "location": "Sudbury",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 8,
   "Sherbrooke": 8,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "P6A",
  "fsa2": "P6C",
  "province": "Ontario",
  "location": "Sault Ste. Marie",
  "zones": {
   "Mississauga": 5,
   "ValleyField": 8,
   "Sherbrooke": 8,
   "Levis": 8,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "P0H",
  "fsa2": "P0K",
  "province": "Ontario",
  "location": "North Bay (Surrounding rural areas)",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P0M",
  "fsa2": "P0S",
  "province": "Ontario",
  "location": "Espanola, Chapleau",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P2B",
  "fsa2": "P2N",
  "province": "Ontario",
  "location": "North Bay",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P4N",
  "fsa2": "P5N",
  "province": "Ontario",
  "location": "Timmins",
  "zones": {
   "Mississauga": 7,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P0L",
  "fsa2": "P0L",
  "province": "Ontario",
  "location": "Kapuskasing, Hearst, Cochrane",
  "zones": {
   "Mississauga": 8,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P0T",
  "fsa2": "P0V",
  "province": "Ontario",
  "location": "Thunder Bay District (rural)",
  "zones": {
   "Mississauga": 8,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P0W",
  "fsa2": "P0Y",
  "province": "Ontario",
  "location": "Fort Frances, Rainy River",
  "zones": {
   "Mississauga": 8,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P7A",
  "fsa2": "P7K",
  "province": "Ontario",
  "location": "Thunder Bay (North)",
  "zones": {
   "Mississauga": 8,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "P7L",
  "fsa2": "P9N",
  "province": "Ontario",
  "location": "Thunder Bay (West)",
  "zones": {
   "Mississauga": 8,
   "ValleyField": 8,
   "Sherbrooke": 11,
   "Levis": 11,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 13
  }
 },
 {
  "fsa1": "B2N",
  "fsa2": "B9A",
  "province": "Nova Scotia",
  "location": "Truro",
  "zones": {
   "Mississauga": 9,
   "ValleyField": 9,
   "Sherbrooke": 10,
   "Levis": 9,
   "Moncton": 3,
   "Dartmouth": 1,
   "Nfld": 9
  }
 },
 {
  "fsa1": "E1A",
  "fsa2": "E3G",
  "province": "New Brunswick",
  "location": "Moncton",
  "zones": {
   "Mississauga": 9,
   "ValleyField": 9,
   "Sherbrooke": 10,
   "Levis": 9,
   "Moncton": 2,
   "Dartmouth": 3,
   "Nfld": 9
  }
 },
 {
  "fsa1": "B0A",
  "fsa2": "B2J",
  "province": "Nova Scotia",
  "location": "Rural Nova Scotia (general area, may vary by exact address)",
  "zones": {
   "Mississauga": 10,
   "ValleyField": 10,
   "Sherbrooke": 11,
   "Levis": 10,
   "Moncton": 6,
   "Dartmouth": 3,
   "Nfld": 9
  }
 },
 {
  "fsa1": "C0A",
  "fsa2": "C1N",
  "province": "Prince Edward Island",
  "location": "Eastern PEI (rural areas including Souris and Montague)",
  "zones": {
   "Mississauga": 10,
   "ValleyField": 10,
   "Sherbrooke": 11,
   "Levis": 10,
   "Moncton": 4,
   "Dartmouth": 4,
   "Nfld": 5
  }
 },
 {
  "fsa1": "E0A",
  "fsa2": "E0L",
  "province": "New Brunswick",
  "location": "Rural New Brunswick",
  "zones": {
   "Mississauga": 10,
   "ValleyField": 10,
   "Sherbrooke": 11,
   "Levis": 10,
   "Moncton": 3,
   "Dartmouth": 5,
   "Nfld": 9
  }
 },
 {
  "fsa1": "E3L",
  "fsa2": "E9H",
  "province": "New Brunswick",
  "location": "St. Stephen",
  "zones": {
   "Mississauga": 10,
   "ValleyField": 10,
   "Sherbrooke": 11,
   "Levis": 10,
   "Moncton": 3,
   "Dartmouth": 5,
   "Nfld": 9
  }
 },
 {
  "fsa1": "R2C",
  "fsa2": "R4L",
  "province": "Manitoba",
  "location": "0",
  "zones": {
   "Mississauga": 10,
   "ValleyField": 11,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 11,
   "Dartmouth": 11,
   "Nfld": 12
  }
 },
 {
  "fsa1": "R0A",
  "fsa2": "R1N",
  "province": "Manitoba",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "R5A",
  "fsa2": "R9A",
  "province": "Manitoba",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "S4K",
  "fsa2": "S4Z",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 15
  }
 },
 {
  "fsa1": "S7H",
  "fsa2": "S7W",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T1X",
  "fsa2": "T4C",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 13,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 13
  }
 },
 {
  "fsa1": "T4V",
  "fsa2": "T6Z",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 13
  }
 },
 {
  "fsa1": "T7X",
  "fsa2": "T8R",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 13
  }
 },
 {
  "fsa1": "T9E",
  "fsa2": "T9G",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 11,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 12,
   "Dartmouth": 12,
   "Nfld": 13
  }
 },
 {
  "fsa1": "A1A",
  "fsa2": "A2N",
  "province": "Newfoundland and Labrador",
  "location": "St. John's",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 3
  }
 },
 {
  "fsa1": "A5A",
  "fsa2": "A8A",
  "province": "Newfoundland and Labrador",
  "location": "Clarenville / Bonavista",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 12,
   "Sherbrooke": 12,
   "Levis": 12,
   "Moncton": 9,
   "Dartmouth": 9,
   "Nfld": 3
  }
 },
 {
  "fsa1": "T0C",
  "fsa2": "T0C",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T0M",
  "fsa2": "T0M",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T4E",
  "fsa2": "T4T",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T9A",
  "fsa2": "T9A",
  "province": "Alberta",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "V1M",
  "fsa2": "V1M",
  "province": "British Columbia",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "V2P",
  "fsa2": "V4S",
  "province": "British Columbia",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "V4W",
  "fsa2": "V7Z",
  "province": "British Columbia",
  "location": "0",
  "zones": {
   "Mississauga": 12,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 14
  }
 },
 {
  "fsa1": "S0A",
  "fsa2": "S4H",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 15
  }
 },
 {
  "fsa1": "S6H",
  "fsa2": "S7C",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 15
  }
 },
 {
  "fsa1": "S9A",
  "fsa2": "S9H",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 15
  }
 },
 {
  "fsa1": "S9V",
  "fsa2": "S9V",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "S9X",
  "fsa2": "S9X",
  "province": "Saskatchewan",
  "location": "0",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T0A",
  "fsa2": "T0B",
  "province": "Alberta",
  "location": "Vegreville, Two Hills, Smoky Lake",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T0E",
  "fsa2": "T0E",
  "province": "Alberta",
  "location": "Jasper, Hinton, Evansburg",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T0G",
  "fsa2": "T0H",
  "province": "Alberta",
  "location": "Slave Lake, High Prairie, Wabasca",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T0J",
  "fsa2": "T0L",
  "province": "Alberta",
  "location": "Drumheller, Strathmore, Brooks",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T0P",
  "fsa2": "T0V",
  "province": "Alberta",
  "location": "High Level, Manning, Peace River",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T1A",
  "fsa2": "T1W",
  "province": "Alberta",
  "location": "Medicine Hat",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T7A",
  "fsa2": "T7V",
  "province": "Alberta",
  "location": "Drayton Valley",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T8S",
  "fsa2": "T8S",
  "province": "Alberta",
  "location": "Peace River",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T8T",
  "fsa2": "T8T",
  "province": "Alberta",
  "location": "Grande Prairie (West)",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 15
  }
 },
 {
  "fsa1": "T8V",
  "fsa2": "T8X",
  "province": "Alberta",
  "location": "Grande Prairie (Central)",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T9C",
  "fsa2": "T9C",
  "province": "Alberta",
  "location": "Camrose",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T9H",
  "fsa2": "T9M",
  "province": "Alberta",
  "location": "Fort McMurray (Central)",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 13,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 14
  }
 },
 {
  "fsa1": "T9N",
  "fsa2": "T9X",
  "province": "Alberta",
  "location": "Bonnyville",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 13,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 13,
   "Dartmouth": 13,
   "Nfld": 15
  }
 },
 {
  "fsa1": "A0A",
  "fsa2": "A0R",
  "province": "Newfoundland and Labrador",
  "location": "Conception Bay / Avalon Peninsula",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 12,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 7
  }
 },
 {
  "fsa1": "A2V",
  "fsa2": "A2V",
  "province": "A0K3B0",
  "location": "Sept-\u00celes, C\u00f4te-Nord region",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 13,
   "Sherbrooke": 13,
   "Levis": 12,
   "Moncton": 10,
   "Dartmouth": 10,
   "Nfld": 7
  }
 },
 {
  "fsa1": "V0A",
  "fsa2": "V0B",
  "province": "British Columbia",
  "location": "Golden, Invermere, Radium Hot Springs",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0G",
  "fsa2": "V0G",
  "province": "British Columbia",
  "location": "Castlegar, Slocan Valley, New Denver",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0J",
  "fsa2": "V0J",
  "province": "British Columbia",
  "location": "Smithers, Burns Lake, Houston",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0L",
  "fsa2": "V0L",
  "province": "British Columbia",
  "location": "Quesnel (rural), Wells",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0S",
  "fsa2": "V0S",
  "province": "British Columbia",
  "location": "Northern Vancouver Island (Port Hardy, Alert Bay)",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1A",
  "fsa2": "V1A",
  "province": "British Columbia",
  "location": "Trail",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1C",
  "fsa2": "V1C",
  "province": "British Columbia",
  "location": "Cranbrook",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1L",
  "fsa2": "V1L",
  "province": "British Columbia",
  "location": "Nelson",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1N",
  "fsa2": "V1N",
  "province": "British Columbia",
  "location": "Castlegar",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1R",
  "fsa2": "V1R",
  "province": "British Columbia",
  "location": "Rossland",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V2G",
  "fsa2": "V2G",
  "province": "British Columbia",
  "location": "Williams Lake",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V2J",
  "fsa2": "V2N",
  "province": "British Columbia",
  "location": "Quesnel",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V8K",
  "fsa2": "V9E",
  "province": "British Columbia",
  "location": "Salt Spring Island",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V9G",
  "fsa2": "V9Y",
  "province": "British Columbia",
  "location": "Ladysmith",
  "zones": {
   "Mississauga": 13,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 14,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0E",
  "fsa2": "V0E",
  "province": "British Columbia",
  "location": "Salmon Arm, Sicamous, Armstrong",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0H",
  "fsa2": "V0H",
  "province": "British Columbia",
  "location": "Osoyoos, Oliver, Keremeos",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0K",
  "fsa2": "V0K",
  "province": "British Columbia",
  "location": "Ashcroft, Lillooet, Clinton",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0M",
  "fsa2": "V0M",
  "province": "British Columbia",
  "location": "Hope, Agassiz, Harrison Hot Springs",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0X",
  "fsa2": "V0X",
  "province": "British Columbia",
  "location": "Princeton, Merritt, Lytton",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1B",
  "fsa2": "V1B",
  "province": "British Columbia",
  "location": "Vernon (East)",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1E",
  "fsa2": "V1E",
  "province": "British Columbia",
  "location": "Salmon Arm",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1H",
  "fsa2": "V1H",
  "province": "British Columbia",
  "location": "Vernon (West), Fintry",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1K",
  "fsa2": "V1K",
  "province": "British Columbia",
  "location": "Merritt",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1P",
  "fsa2": "V1P",
  "province": "British Columbia",
  "location": "Kelowna (East)",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1S",
  "fsa2": "V2E",
  "province": "British Columbia",
  "location": "Kamloops (rural)",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V2H",
  "fsa2": "V2H",
  "province": "British Columbia",
  "location": "Kamloops (North Shore & Westsyde)",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V4T",
  "fsa2": "V4V",
  "province": "British Columbia",
  "location": "West Kelowna",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 14,
   "Sherbrooke": 14,
   "Levis": 14,
   "Moncton": 14,
   "Dartmouth": 14,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0C",
  "fsa2": "V0C",
  "province": "British Columbia",
  "location": "Fort Nelson",
  "zones": {
   "Mississauga": 15,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1G",
  "fsa2": "V1G",
  "province": "British Columbia",
  "location": "Dawson Creek",
  "zones": {
   "Mississauga": 15,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V1J",
  "fsa2": "V1J",
  "province": "British Columbia",
  "location": "Fort St. John",
  "zones": {
   "Mississauga": 15,
   "ValleyField": 14,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0N",
  "fsa2": "V0R",
  "province": "British Columbia",
  "location": "Whistler, Pemberton, Bowen Island",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 15,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V8A",
  "fsa2": "V8B",
  "province": "British Columbia",
  "location": "Powell River",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 15,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V9Z",
  "fsa2": "V9Z",
  "province": "British Columbia",
  "location": "Sooke",
  "zones": {
   "Mississauga": 14,
   "ValleyField": 15,
   "Sherbrooke": 15,
   "Levis": 15,
   "Moncton": 15,
   "Dartmouth": 15,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V0T",
  "fsa2": "V0W",
  "province": "British Columbia",
  "location": "Haida Gwaii, Bella Coola, Kitimat-Stikine",
  "zones": {
   "Mississauga": 15,
   "ValleyField": 15,
   "Sherbrooke": 16,
   "Levis": 16,
   "Moncton": 16,
   "Dartmouth": 16,
   "Nfld": 16
  }
 },
 {
  "fsa1": "V8C",
  "fsa2": "V8J",
  "province": "British Columbia",
  "location": "Kitimat",
  "zones": {
   "Mississauga": 15,
   "ValleyField": 15,
   "Sherbrooke": 16,
   "Levis": 16,
   "Moncton": 16,
   "Dartmouth": 16,
   "Nfld": 16
  }
 },
 {
  "fsa1": "X0A",
  "fsa2": "X0C",
  "province": "Northwest Territories",
  "location": "Eastern Arctic (including Iqaluit, Nunavut before creation)",
  "zones": {
   "Mississauga": 16,
   "ValleyField": 16,
   "Sherbrooke": 16,
   "Levis": 16,
   "Moncton": 16,
   "Dartmouth": 16,
   "Nfld": 16
  }
 },
 {
  "fsa1": "X0E",
  "fsa2": "X1A",
  "province": "Northwest Territories",
  "location": "Yellowknife, Hay River",
  "zones": {
   "Mississauga": 16,
   "ValleyField": 16,
   "Sherbrooke": 16,
   "Levis": 16,
   "Moncton": 16,
   "Dartmouth": 16,
   "Nfld": 16
  }
 },
 {
  "fsa1": "Y0A",
  "fsa2": "Y1A",
  "province": "Yukon",
  "location": "Whitehorse and surrounding areas",
  "zones": {
   "Mississauga": 16,
   "ValleyField": 16,
   "Sherbrooke": 16,
   "Levis": 16,
   "Moncton": 16,
   "Dartmouth": 16,
   "Nfld": 16
  }
 }
];
