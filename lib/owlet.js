/**
 * Owlet Smart Sock client (v2/v3) - Node.js port.
 *
 * Usage:
 *   const { Owlet } = require('./owlet');
 *   const owlet = await Owlet.create('you@example.com', 'password', 'europe');
 *   const data = await owlet.read();
 *   console.log(data.heart_rate, data.oxygen);
 */

const REGIONS = {
  world: {
    firebase_api_key: 'AIzaSyCsDZ8kWxQuLJAMVnmEhEkayH1TSxKXfGA',
    url_mini: 'https://ayla-sso.owletdata.com/mini/',
    url_signin: 'https://user-field-1a2039d9.aylanetworks.com/api/v1/token_sign_in',
    url_base: 'https://ads-field-1a2039d9.aylanetworks.com/apiv1',
    app_id: 'sso-prod-3g-id',
    app_secret: 'sso-prod-UEjtnPCtFfjdwIwxqnC0OipxRFU',
  },
  europe: {
    firebase_api_key: 'AIzaSyDm6EhV70wudwN3iOSq3vTjtsdGjdFLuuM',
    url_mini: 'https://ayla-sso.eu.owletdata.com/mini/',
    url_signin: 'https://user-field-eu-1a2039d9.aylanetworks.com/api/v1/token_sign_in',
    url_base: 'https://ads-field-eu-1a2039d9.aylanetworks.com/apiv1',
    app_id: 'OwletCare-Android-EU-fw-id',
    app_secret: 'OwletCare-Android-EU-JKupMPBoj_Npce_9a95Pc8Qo0Mw',
  },
};

const ANDROID_HEADERS = {
  'X-Android-Package': 'com.owletcare.owletcare',
  'X-Android-Cert': '2A3BC26DB0B8B0792DBE28E6FFDC2598F9B12B74',
};

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

// --- Auth helpers ---

async function firebaseSignIn(email, password, cfg) {
  const url = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${cfg.firebase_api_key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...ANDROID_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new OwletError(`Firebase sign-in failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.idToken) {
    throw new OwletError(`Firebase sign-in: unexpected response: ${JSON.stringify(data)}`);
  }
  return data.idToken;
}

async function getMiniToken(idToken, cfg) {
  const resp = await fetch(cfg.url_mini, {
    headers: { Authorization: idToken },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new OwletError(`SSO mini-token failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.mini_token) {
    throw new OwletError(`SSO mini-token: unexpected response: ${JSON.stringify(data)}`);
  }
  return data.mini_token;
}

async function aylaSignIn(miniToken, cfg) {
  const resp = await fetch(cfg.url_signin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: cfg.app_id,
      app_secret: cfg.app_secret,
      provider: 'owl_id',
      token: miniToken,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status !== 200 && resp.status !== 201) {
    throw new OwletError(`Ayla sign-in failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new OwletError(`Ayla sign-in: no access_token in response: ${JSON.stringify(data)}`);
  }
  return { token: data.access_token, ttl: parseInt(data.expires_in || '86400', 10) };
}

async function authenticate(email, password, cfg) {
  const idToken = await firebaseSignIn(email, password, cfg);
  const miniToken = await getMiniToken(idToken, cfg);
  const { token, ttl } = await aylaSignIn(miniToken, cfg);
  const expiry = Date.now() + ttl * 1000 - 60000; // re-auth 60s before expiry
  return { token, expiry };
}

// --- Device helpers ---

function authHeader(token) {
  return { Authorization: `auth_token ${token}` };
}

async function getDsns(token, cfg) {
  const resp = await fetch(`${cfg.url_base}/devices.json`, {
    headers: authHeader(token),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new OwletError(`Device list failed (${resp.status}): ${await resp.text()}`);
  }
  const devices = await resp.json();
  if (!devices || devices.length === 0) {
    throw new OwletError('No Owlet devices found on this account.');
  }
  return devices.map((d) => d.device.dsn);
}

async function activate(dsn, token, cfg) {
  const resp = await fetch(
    `${cfg.url_base}/dsns/${dsn}/properties/${PROP_ACTIVE}/datapoints.json`,
    {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ datapoint: { metadata: {}, value: 1 } }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (resp.status !== 200 && resp.status !== 201) {
    throw new OwletError(`APP_ACTIVE post failed (${resp.status}): ${await resp.text()}`);
  }
}

async function getProps(dsn, token, cfg) {
  const resp = await fetch(`${cfg.url_base}/dsns/${dsn}/properties.json`, {
    headers: authHeader(token),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new OwletError(`Property fetch failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  const props = {};
  for (const p of data) {
    props[p.property.name] = p.property.value;
  }
  return props;
}

function parse(dsn, props) {
  let rtv = null;
  const rawRtv = props[PROP_RTV];
  if (typeof rawRtv === 'string' && rawRtv.trim().startsWith('{')) {
    try {
      rtv = JSON.parse(rawRtv);
    } catch {
      // ignore parse errors
    }
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (rtv !== null) {
    const sockConnected = Boolean(rtv.sc);
    return {
      heart_rate: rtv.hr ?? null,
      oxygen: rtv.ox ?? null,
      battery: rtv.bat ?? null,
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
    heart_rate: props[PROP_HR] ?? null,
    oxygen: props[PROP_OX] ?? null,
    battery: props[PROP_BAT] ?? null,
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

class OwletError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwletError';
  }
}

class Owlet {
  static async create(email, password, region = 'world', dsn = null) {
    if (!REGIONS[region]) {
      throw new Error(`region must be one of ${Object.keys(REGIONS).join(', ')}`);
    }

    const owlet = new Owlet();
    owlet._email = email;
    owlet._password = password;
    owlet._cfg = REGIONS[region];

    const auth = await authenticate(email, password, owlet._cfg);
    owlet._token = auth.token;
    owlet._expiry = auth.expiry;

    const dsns = await getDsns(owlet._token, owlet._cfg);
    owlet._dsn = dsn || dsns[0];

    return owlet;
  }

  async read() {
    // Re-authenticate if token is about to expire
    if (Date.now() >= this._expiry) {
      const auth = await authenticate(this._email, this._password, this._cfg);
      this._token = auth.token;
      this._expiry = auth.expiry;
    }

    await activate(this._dsn, this._token, this._cfg);
    await new Promise((r) => setTimeout(r, 2000)); // give base station time to push data

    const props = await getProps(this._dsn, this._token, this._cfg);
    return parse(this._dsn, props);
  }
}

module.exports = { Owlet, OwletError };
