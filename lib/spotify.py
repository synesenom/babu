#!/usr/bin/env python3
"""
Spotify Controller Module
Control Spotify playback including playlists and device selection.

Usage:
    import spotify_controller
    
    # Initialize
    controller = spotify_controller.SpotifyController(
        client_id='your_client_id',
        client_secret='your_client_secret'
    )
    
    # Use functions
    controller.start_playlist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', device_name='iphone')
    controller.get_remaining_seconds()
    controller.print_now_playing()
"""

import spotipy
from spotipy.oauth2 import SpotifyOAuth
from typing import Optional, List, Dict


class SpotifyController:
    """Main controller class for Spotify operations"""

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str = 'http://127.0.0.1:8888/callback'):
        """
        Initialize the Spotify controller.

        Args:
            client_id: Your Spotify API client ID
            client_secret: Your Spotify API client secret
            redirect_uri: OAuth redirect URI (default: http://127.0.0.1:8888/callback)
        """
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri

        # Scopes needed for full playback control
        scope = 'user-modify-playback-state user-read-playback-state'

        try:
            self.auth_manager = SpotifyOAuth(
                client_id=self.client_id,
                client_secret=self.client_secret,
                redirect_uri=self.redirect_uri,
                scope=scope,
                open_browser=True
            )
            self.sp = spotipy.Spotify(auth_manager=self.auth_manager)

            # Try to get current user to verify auth works
            try:
                self.sp.current_user()
            except Exception as auth_error:
                if "No token" in str(auth_error) or "No authorized" in str(auth_error):
                    print("\n⚠️  Browser authentication window didn't open.")
                    print("\nMANUAL AUTHENTICATION STEPS:")
                    print("1. Copy this URL and paste it in your browser:")
                    print(f"\n   {self.auth_manager.get_authorize_url()}\n")
                    print("2. Log in and authorize the app")
                    print("3. You'll be redirected to a URL starting with http://127.0.0.1:8888/")
                    print("4. Copy that ENTIRE URL from your browser")
                    auth_url = input("\n5. Paste the URL here and press Enter: ").strip()

                    # Extract the code from the URL
                    code = self.auth_manager.parse_response_code(auth_url)
                    token = self.auth_manager.get_access_token(code, as_dict=False)
                    self.sp = spotipy.Spotify(auth=token)
                    print("\n✓ Authentication successful!")
                else:
                    raise

        except Exception as e:
            print(f"✗ Authentication error: {e}")
            print("\nTroubleshooting steps:")
            print("1. Delete the .cache file: rm .cache")
            print("2. Verify your CLIENT_ID and CLIENT_SECRET are correct")
            print("3. Check redirect URI in Spotify dashboard: http://127.0.0.1:8888/callback")
            print("4. Make sure your Spotify app is not in Development Mode restrictions")
            raise

    def refresh_token(self) -> bool:
        """
        Manually refresh the access token.

        This is useful if you want to ensure you have a fresh token without
        waiting for automatic refresh. Spotipy automatically refreshes tokens
        when they expire, but you can call this to force a refresh.

        Returns:
            True if refresh was successful, False otherwise
        """
        try:
            # Get current token info
            token_info = self.auth_manager.get_cached_token()

            if token_info is None:
                print("No cached token found. Please authenticate first.")
                return False

            # Check if token is expired and refresh if needed
            if self.auth_manager.is_token_expired(token_info):
                print("Token expired, refreshing...")
                token_info = self.auth_manager.refresh_access_token(token_info['refresh_token'])
                print("✓ Token refreshed successfully")
            else:
                print("Token is still valid, no refresh needed")

            return True

        except Exception as e:
            print(f"✗ Error refreshing token: {e}")
            return False

    def get_token_info(self) -> Optional[Dict]:
        """
        Get information about the current token.

        Returns:
            Dictionary with token info including expiration time, or None if no token
        """
        try:
            token_info = self.auth_manager.get_cached_token()

            if token_info is None:
                print("No cached token found.")
                return None

            import time
            expires_at = token_info.get('expires_at', 0)
            expires_in = expires_at - int(time.time())
            is_expired = self.auth_manager.is_token_expired(token_info)

            info = {
                'access_token': token_info.get('access_token', '')[:20] + '...',  # Truncated for security
                'token_type': token_info.get('token_type', ''),
                'expires_at': expires_at,
                'expires_in_seconds': expires_in,
                'is_expired': is_expired,
                'scope': token_info.get('scope', ''),
            }

            return info

        except Exception as e:
            print(f"Error getting token info: {e}")
            return None

    def print_token_info(self) -> None:
        """Print formatted token information."""
        info = self.get_token_info()

        if info is None:
            return

        print("\n=== Token Information ===")
        print(f"Token Type: {info['token_type']}")
        print(f"Scope: {info['scope']}")
        print(f"Expires In: {info['expires_in_seconds']} seconds ({info['expires_in_seconds']/60:.1f} minutes)")
        print(f"Is Expired: {info['is_expired']}")
        print(f"Access Token: {info['access_token']}")

    def get_current_playback(self) -> Optional[Dict]:
        """
        Get detailed information about current playback.

        Returns:
            Dictionary with playback info including:
            - is_playing: bool
            - track_name: str
            - artist_name: str
            - album_name: str
            - progress_ms: int (current position in milliseconds)
            - duration_ms: int (total track duration in milliseconds)
            - remaining_ms: int (time remaining in milliseconds)
            - remaining_seconds: float (time remaining in seconds)
            - device_name: str
            - device_type: str
            Or None if nothing is playing
        """
        try:
            playback = self.sp.current_playback()

            if playback is None or playback.get('item') is None:
                print("No track currently playing.")
                return None

            track = playback['item']
            progress_ms = playback.get('progress_ms', 0)
            duration_ms = track.get('duration_ms', 0)
            remaining_ms = duration_ms - progress_ms

            info = {
                'is_playing': playback.get('is_playing', False),
                'track_name': track.get('name', 'Unknown'),
                'artist_name': ', '.join([artist['name'] for artist in track.get('artists', [])]),
                'album_name': track.get('album', {}).get('name', 'Unknown'),
                'progress_ms': progress_ms,
                'duration_ms': duration_ms,
                'remaining_ms': remaining_ms,
                'remaining_seconds': remaining_ms / 1000.0,
                'progress_seconds': progress_ms / 1000.0,
                'duration_seconds': duration_ms / 1000.0,
                'device_name': playback.get('device', {}).get('name', 'Unknown'),
                'device_type': playback.get('device', {}).get('type', 'Unknown'),
                'shuffle_state': playback.get('shuffle_state', False),
                'repeat_state': playback.get('repeat_state', 'off'),
            }

            return info

        except Exception as e:
            print(f"Error getting playback info: {e}")
            return None

    def get_remaining_seconds(self) -> Optional[float]:
        """
        Get the remaining seconds of the current song.

        Returns:
            Number of seconds remaining in current track, or None if nothing is playing

        Example:
            remaining = controller.get_remaining_seconds()
            if remaining:
                print(f"{remaining:.1f} seconds left")
        """
        playback = self.get_current_playback()
        if playback:
            return playback['remaining_seconds']
        return None

    def print_now_playing(self) -> bool:
        """
        Print detailed information about what's currently playing.

        Returns:
            True if something is playing, False otherwise
        """
        playback = self.get_current_playback()

        if not playback:
            return False

        print("\n=== Now Playing ===")
        print(f"Track: {playback['track_name']}")
        print(f"Artist: {playback['artist_name']}")
        print(f"Album: {playback['album_name']}")
        print(f"Device: {playback['device_name']} ({playback['device_type']})")
        print(f"Status: {'Playing' if playback['is_playing'] else 'Paused'}")

        # Progress bar
        progress_sec = int(playback['progress_seconds'])
        duration_sec = int(playback['duration_seconds'])
        remaining_sec = int(playback['remaining_seconds'])

        progress_min = progress_sec // 60
        progress_sec_rem = progress_sec % 60
        duration_min = duration_sec // 60
        duration_sec_rem = duration_sec % 60

        print(f"Progress: {progress_min}:{progress_sec_rem:02d} / {duration_min}:{duration_sec_rem:02d}")
        print(f"Remaining: {remaining_sec} seconds")

        # Simple progress bar
        bar_width = 30
        progress_pct = playback['progress_ms'] / playback['duration_ms']
        filled = int(bar_width * progress_pct)
        bar = '█' * filled + '░' * (bar_width - filled)
        print(f"[{bar}] {progress_pct * 100:.1f}%")

        print(f"Shuffle: {'On' if playback['shuffle_state'] else 'Off'}")
        print(f"Repeat: {playback['repeat_state']}")

        return True

    def get_devices(self) -> List[Dict]:
        """
        Get list of available Spotify devices.

        Returns:
            List of device dictionaries with 'id', 'name', 'type', 'is_active', etc.
        """
        devices = self.sp.devices()
        return devices['devices']

    def list_devices(self) -> None:
        """Print all available devices to console."""
        devices = self.get_devices()
        if not devices:
            print("No devices found. Make sure Spotify is open on at least one device.")
            return

        print("\nAvailable devices:")
        for idx, device in enumerate(devices):
            status = "Active" if device['is_active'] else "Inactive"
            print(f"{idx + 1}. {device['name']} ({device['type']}) - {status}")
            print(f"   ID: {device['id']}")
            print(f"   Volume: {device['volume_percent']}%")

    def find_device_by_name(self, name_substring: str) -> Optional[str]:
        """
        Find a device ID by matching part of its name (case-insensitive).

        Args:
            name_substring: Part of the device name to search for

        Returns:
            Device ID if found, None otherwise
        """
        devices = self.get_devices()
        for device in devices:
            if name_substring.lower() in device['name'].lower():
                return device['id']
        return None

    def get_active_device(self) -> Optional[str]:
        """
        Get the currently active device ID.

        Returns:
            Active device ID if found, None otherwise
        """
        devices = self.get_devices()
        for device in devices:
            if device['is_active']:
                return device['id']
        return None

    def start_playlist(self, playlist_uri: str, device_name: Optional[str] = None, device_id: Optional[str] = None) -> bool:
        """
        Start playing a playlist on a specified device.

        Args:
            playlist_uri: Spotify playlist URI (format: spotify:playlist:PLAYLIST_ID)
            device_name: Name (or partial name) of device to play on
            device_id: Specific device ID to play on (overrides device_name)

        Returns:
            True if successful, False otherwise

        Example:
            start_playlist('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', device_name='iphone')
        """
        try:
            # Determine which device to use
            target_device = None

            if device_id:
                target_device = device_id
            elif device_name:
                target_device = self.find_device_by_name(device_name)
                if not target_device:
                    print(f"Device '{device_name}' not found.")
                    self.list_devices()
                    return False
            else:
                # Use active device if no device specified
                target_device = self.get_active_device()
                if not target_device:
                    print("No active device found. Please specify a device or start Spotify on a device.")
                    return False

            self.sp.start_playback(device_id=target_device, context_uri=playlist_uri)
            print(f"✓ Playlist started successfully!")
            return True

        except Exception as e:
            print(f"✗ Error starting playlist: {e}")
            print("\nMake sure:")
            print("- Spotify is open on your device")
            print("- Your device is connected to the internet")
            print("- You have Spotify Premium (required for Web API playback)")
            return False

    def set_crossfade(self, duration_ms: int, device_name: Optional[str] = None, device_id: Optional[str] = None) -> bool:
        """
        Set crossfade duration for smooth transitions between songs.

        This enables the smooth transition (crossfade) that you get in Master mode.
        Crossfade duration can be 0-12000 milliseconds (0-12 seconds).

        Args:
            duration_ms: Crossfade duration in milliseconds (0-12000)
                        0 = no crossfade (gap between songs)
                        6000 = 6 second crossfade (typical smooth transition)
                        12000 = 12 second crossfade (maximum overlap)
            device_name: Name (or partial name) of device
            device_id: Specific device ID (overrides device_name)

        Returns:
            True if successful, False otherwise

        Example:
            # Enable 6-second smooth transitions (like Master mode)
            controller.set_crossfade(6000, device_name='iphone')

            # Then start your playlist
            controller.start_playlist('spotify:playlist:...', device_name='iphone')
        """
        try:
            # Clamp duration to valid range
            duration_ms = max(0, min(12000, duration_ms))

            # Determine which device to use
            target_device = None

            if device_id:
                target_device = device_id
            elif device_name:
                target_device = self.find_device_by_name(device_name)
                if not target_device:
                    print(f"Device '{device_name}' not found.")
                    return False
            else:
                target_device = self.get_active_device()
                if not target_device:
                    print("No active device found.")
                    return False

            # Set the crossfade using the Spotify API
            # Note: This is a PUT request to the player endpoint
            self.sp.playback_set_crossfade(duration_ms, device_id=target_device)
            print(f"✓ Crossfade set to {duration_ms}ms ({duration_ms/1000:.1f} seconds)")
            return True

        except Exception as e:
            error_msg = str(e)
            print(f"✗ Error setting crossfade: {e}")

            # Provide helpful guidance
            if "PREMIUM_REQUIRED" in error_msg or "Premium" in error_msg:
                print("   Crossfade requires Spotify Premium")
            elif "Playback state is not active" in error_msg:
                print("   Start playing music first, then set crossfade")

            return False

    def get_crossfade(self) -> Optional[int]:
        """
        Get the current crossfade duration.

        Returns:
            Crossfade duration in milliseconds, or None if unavailable
        """
        try:
            # Get current playback state which includes crossfade info
            playback = self.sp.current_playback()

            if playback is None:
                print("No active playback to check crossfade.")
                return None

            # The crossfade setting is not directly returned by current_playback()
            # Unfortunately, there's no direct API to GET crossfade settings
            # You can only SET them
            print("Note: Spotify API doesn't provide a way to read crossfade settings.")
            print("You can only set crossfade, not read the current value.")
            return None

        except Exception as e:
            print(f"Error checking crossfade: {e}")
            return None

    def pause(self, device_name: Optional[str] = None, device_id: Optional[str] = None) -> bool:
        """
        Pause playback.

        Args:
            device_name: Name (or partial name) of device
            device_id: Specific device ID (overrides device_name)

        Returns:
            True if successful, False otherwise
        """
        try:
            target_device = device_id or (self.find_device_by_name(device_name) if device_name else None)
            self.sp.pause_playback(device_id=target_device)
            print("✓ Playback paused")
            return True
        except Exception as e:
            print(f"✗ Error pausing: {e}")
            return False

    def play(self, device_name: Optional[str] = None, device_id: Optional[str] = None) -> bool:
        """
        Resume playback.

        Args:
            device_name: Name (or partial name) of device
            device_id: Specific device ID (overrides device_name)

        Returns:
            True if successful, False otherwise
        """
        try:
            target_device = device_id or (self.find_device_by_name(device_name) if device_name else None)
            self.sp.start_playback(device_id=target_device)
            print("✓ Playback resumed")
            return True
        except Exception as e:
            print(f"✗ Error resuming: {e}")
            return False


# Example usage
if __name__ == '__main__':
    # Initialize controller with your credentials
    CLIENT_ID = 'your_client_id_here'
    CLIENT_SECRET = 'your_client_secret_here'

    controller = SpotifyController(
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET
    )

    # List available devices
    print("=== Available Devices ===")
    controller.list_devices()
