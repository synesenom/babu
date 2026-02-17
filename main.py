from os import environ
from time import sleep
from lib.owlet import Owlet
from lib.spotify import SpotifyController

# Spotify playlists.
CHOPIN_PLAYLIST = 'spotify:playlist:5MKaz5wxcypYQLklyx34J2'
WHITENOISE_PLAYLISY = 'spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx'

# Initialize owlet and spotify.
owlet = Owlet('enys.mones@gmail.com', environ.get('OWLET_PWD'), region='europe')
controller = SpotifyController(
    client_id=environ.get('SPOTIFY_CLIENT_ID'),
    client_secret=environ.get('SPOTIFY_CLIENT_SECRET'),
)


def switch_to_white_noise():
    print('Switching to white noise')

    # Check remaining time from current song.
    remaining_seconds = controller.get_remaining_seconds()

    # Wait for the current song to end, if anything is playing.
    if remaining_seconds is not None:
        sleep(remaining_seconds)

    # Then set crossfade and start white noise.
    # controller.set_crossfade(6000, device_name='iphone')
    return controller.start_playlist(playlist_uri=WHITENOISE_PLAYLISY,
                                     device_name='iphone')


def keep_playing_chopin():
    print('Keep playing Chopin')

    # Check remaining time from current song.
    remaining_seconds = controller.get_remaining_seconds()

    # If nothing is played, start Chopin.
    if remaining_seconds is None:
        return controller.start_playlist(playlist_uri=CHOPIN_PLAYLIST,
                                         device_name='iphone')

    # If remaining time is less than 10 seconds, wait until
    # the song finishes and start Chopin again.
    if remaining_seconds < 10.0:
        sleep(remaining_seconds)
        return controller.start_playlist(playlist_uri=CHOPIN_PLAYLIST,
                                         device_name='iphone')

    # Otherwise just wait 10 seconds.
    sleep(10)


# Start playing Chopin.
print('Starting bedtime routine')

# Start checking heart rate.
while True:
    # Read heart rate.
    data = owlet.read()

    # If heart rate drops below 120, switch to white noise.
    if data['heart_rate'] < 110:
        switch_to_white_noise()
        break

    # Otherwise, keep playing Chopin and wait 10 seconds.
    keep_playing_chopin()
