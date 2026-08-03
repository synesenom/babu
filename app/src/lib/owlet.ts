import type { OwletRegion, OwletReading } from './types';
import { OWLET_REGIONS, ANDROID_SPOOF_HEADERS } from './constants';

const PROP_RTV = 'REAL_TIME_VITALS';
const PROP_HR = 'HEART_RATE';
const PROP_OX = 'OXYGEN_LEVEL';
const PROP_BAT = 'BATT_LEVEL';
const PROP_MV = 'MOVEMENT';
const PROP_BASE = 'BASE_STATION_ON';
const PROP_SOCK = 'SOCK_OFF';
const PROP_CONN = 'SOCK_CONNECTION';
const PROP_CHG = 'CHARGE_STATUS';
const PROP_ACTIVE = 'APP_ACTIVE';

type RegionConfig = (typeof OWLET_REGIONS)[OwletRegion];

function makeSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// Fetches JSON, aborting after 15s and raising OwletError with the response
// body on a status the caller rejects (defaults to non-2xx).
async function fetchJson<T>(
  url: string,
  options: RequestInit,
  errLabel: string,
  isOk: (res: Response) => boolean = (res) => res.ok,
): Promise<T> {
  const resp = await fetch(url, { ...options, signal: makeSignal(15000) });
  if (!isOk(resp)) {
    throw new OwletError(`${errLabel} failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

// --- Auth helpers ---

async function firebaseSignIn(email: string, password: string, cfg: RegionConfig): Promise<string> {
  const url = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${cfg.firebase_api_key}`;
  const data = await fetchJson<{ idToken?: string }>(
    url,
    {
      method: 'POST',
      headers: { ...ANDROID_SPOOF_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
    'Firebase sign-in',
  );
  if (!data.idToken) {
    throw new OwletError(`Firebase sign-in: unexpected response: ${JSON.stringify(data)}`);
  }
  return data.idToken;
}

async function getMiniToken(idToken: string, cfg: RegionConfig): Promise<string> {
  const data = await fetchJson<{ mini_token?: string }>(
    cfg.url_mini,
    { headers: { Authorization: idToken } },
    'SSO mini-token',
  );
  if (!data.mini_token) {
    throw new OwletError(`SSO mini-token: unexpected response: ${JSON.stringify(data)}`);
  }
  return data.mini_token;
}

async function aylaSignIn(miniToken: string, cfg: RegionConfig): Promise<{ token: string; ttl: number }> {
  const data = await fetchJson<{ access_token?: string; expires_in?: string }>(
    cfg.url_signin,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        app_id: cfg.app_id,
        app_secret: cfg.app_secret,
        provider: 'owl_id',
        token: miniToken,
      }),
    },
    'Ayla sign-in',
    (res) => res.status === 200 || res.status === 201,
  );
  if (!data.access_token) {
    throw new OwletError(`Ayla sign-in: no access_token in response: ${JSON.stringify(data)}`);
  }
  return { token: data.access_token, ttl: parseInt(data.expires_in ?? '86400', 10) };
}

async function authenticate(
  email: string,
  password: string,
  cfg: RegionConfig,
): Promise<{ token: string; expiry: number }> {
  const idToken = await firebaseSignIn(email, password, cfg);
  const miniToken = await getMiniToken(idToken, cfg);
  const { token, ttl } = await aylaSignIn(miniToken, cfg);
  const expiry = Date.now() + ttl * 1000 - 60000; // re-auth 60s before expiry
  return { token, expiry };
}

// --- Device helpers ---

function authHeader(token: string): Record<string, string> {
  return { Authorization: `auth_token ${token}` };
}

async function getDsns(token: string, cfg: RegionConfig): Promise<string[]> {
  const devices = await fetchJson<Array<{ device: { dsn: string } }>>(
    `${cfg.url_base}/devices.json`,
    { headers: authHeader(token) },
    'Device list',
  );
  if (!devices || devices.length === 0) {
    throw new OwletError('No Owlet devices found on this account.');
  }
  return devices.map((d) => d.device.dsn);
}

async function activate(dsn: string, token: string, cfg: RegionConfig): Promise<void> {
  await fetchJson(
    `${cfg.url_base}/dsns/${dsn}/properties/${PROP_ACTIVE}/datapoints.json`,
    {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ datapoint: { metadata: {}, value: 1 } }),
    },
    'APP_ACTIVE post',
    (res) => res.status === 200 || res.status === 201,
  );
}

async function getProps(
  dsn: string,
  token: string,
  cfg: RegionConfig,
): Promise<Record<string, unknown>> {
  const data = await fetchJson<Array<{ property: { name: string; value: unknown } }>>(
    `${cfg.url_base}/dsns/${dsn}/properties.json`,
    { headers: authHeader(token) },
    'Property fetch',
  );
  const props: Record<string, unknown> = {};
  for (const p of data) {
    props[p.property.name] = p.property.value;
  }
  return props;
}

function parse(dsn: string, props: Record<string, unknown>): OwletReading {
  let rtv: Record<string, unknown> | null = null;
  const rawRtv = props[PROP_RTV];
  if (typeof rawRtv === 'string' && rawRtv.trim().startsWith('{')) {
    try {
      rtv = JSON.parse(rawRtv) as Record<string, unknown>;
    } catch {
      // ignore parse errors
    }
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (rtv !== null) {
    const sockConnected = Boolean(rtv.sc);
    return {
      heart_rate: (rtv.hr as number) ?? null,
      oxygen: (rtv.ox as number) ?? null,
      battery: (rtv.bat as number) ?? null,
      movement: rtv.mv ? 'moving' : 'still',
      sock_off: !sockConnected,
      sock_connected: sockConnected,
      base_on: Boolean(rtv.bso),
      charging: Boolean(rtv.chg),
      dsn,
      timestamp: now,
      raw: props,
    };
  }

  // Legacy firmware fallback
  const mv = props[PROP_MV];
  return {
    heart_rate: (props[PROP_HR] as number) ?? null,
    oxygen: (props[PROP_OX] as number) ?? null,
    battery: (props[PROP_BAT] as number) ?? null,
    movement: typeof mv === 'number' ? (mv ? 'moving' : 'still') : null,
    sock_off: Boolean(props[PROP_SOCK]),
    sock_connected: Boolean(props[PROP_CONN]),
    base_on: Boolean(props[PROP_BASE]),
    charging: Boolean(props[PROP_CHG]),
    dsn,
    timestamp: now,
    raw: props,
  };
}

// --- Public API ---

export class OwletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwletError';
  }
}

export class Owlet {
  private _email: string = '';
  private _password: string = '';
  private _cfg!: RegionConfig;
  private _token: string = '';
  private _expiry: number = 0;
  private _dsn: string = '';

  static async create(
    email: string,
    password: string,
    region: OwletRegion = 'world',
    dsn?: string,
  ): Promise<Owlet> {
    if (!OWLET_REGIONS[region]) {
      throw new Error(`region must be one of ${Object.keys(OWLET_REGIONS).join(', ')}`);
    }

    const owlet = new Owlet();
    owlet._email = email;
    owlet._password = password;
    owlet._cfg = OWLET_REGIONS[region];

    const auth = await authenticate(email, password, owlet._cfg);
    owlet._token = auth.token;
    owlet._expiry = auth.expiry;

    const dsns = await getDsns(owlet._token, owlet._cfg);
    owlet._dsn = dsn ?? dsns[0];

    return owlet;
  }

  async read(): Promise<OwletReading> {
    if (Date.now() >= this._expiry) {
      const auth = await authenticate(this._email, this._password, this._cfg);
      this._token = auth.token;
      this._expiry = auth.expiry;
    }

    await activate(this._dsn, this._token, this._cfg);
    await new Promise<void>((r) => setTimeout(r, 2000)); // give base station time to push data

    const props = await getProps(this._dsn, this._token, this._cfg);
    return parse(this._dsn, props);
  }
}
