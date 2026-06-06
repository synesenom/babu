export const HR_THRESHOLD = 110;
export const POLL_INTERVAL_MS = 10_000;
export const RESTART_THRESHOLD_SECONDS = 10;

export const CHOPIN_PLAYLIST = 'spotify:playlist:5MKaz5wxcypYQLklyx34J2';
export const WHITENOISE_PLAYLIST = 'spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx';

export const SPOTIFY_SCOPES = ['user-modify-playback-state', 'user-read-playback-state'];

export const OWLET_REGIONS = {
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
} as const;

export const ANDROID_SPOOF_HEADERS = {
  'X-Android-Package': 'com.owletcare.owletcare',
  'X-Android-Cert': '2A3BC26DB0B8B0792DBE28E6FFDC2598F9B12B74',
};
