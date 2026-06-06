export const FIREBASE_OK = { idToken: 'fake-id-token' };
export const MINI_TOKEN_OK = { mini_token: 'fake-mini-token' };
export const AYLA_SIGNIN_OK = { access_token: 'fake-ayla-token', expires_in: '86400' };
export const DEVICES_OK = [{ device: { dsn: 'AC000W123456789' } }];
export const ACTIVATE_OK = { datapoint: {} };

// New firmware: REAL_TIME_VITALS JSON blob
export const PROPS_RTV_OK = [
  {
    property: {
      name: 'REAL_TIME_VITALS',
      value: JSON.stringify({ hr: 125, ox: 98, bat: 82, mv: 0, sc: 1, bso: 1, chg: 0 }),
    },
  },
];

// Old firmware: individual properties
export const PROPS_LEGACY_OK = [
  { property: { name: 'HEART_RATE', value: 118 } },
  { property: { name: 'OXYGEN_LEVEL', value: 97 } },
  { property: { name: 'BATT_LEVEL', value: 75 } },
  { property: { name: 'MOVEMENT', value: 1 } },
  { property: { name: 'SOCK_OFF', value: 0 } },
  { property: { name: 'SOCK_CONNECTION', value: 1 } },
  { property: { name: 'BASE_STATION_ON', value: 1 } },
  { property: { name: 'CHARGE_STATUS', value: 0 } },
];
