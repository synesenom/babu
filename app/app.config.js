const base = require('./app.json').expo;

module.exports = {
  expo: {
    ...base,
    extra: {
      spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
      spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
      mockMode: process.env.MOCK_MODE === '1',
    },
  },
};
