import lobbyTime from '../assets/music/lobby-time.mp3'
import crinolineDreams from '../assets/music/crinoline-dreams.mp3'
import chill from '../assets/music/chill.mp3'
import localForecast from '../assets/music/local-forecast.mp3'
import tropicalBeach from '../assets/sounds/ambience.mp3'

// Bundled audio for the tracks in player.ts, keyed by track id. A missing
// import is a build error, so the map cannot drift silently.
export const TRACK_SOURCES: Record<string, string> = {
  'lobby-time': lobbyTime,
  'crinoline-dreams': crinolineDreams,
  chill,
  'local-forecast': localForecast,
  'tropical-beach': tropicalBeach,
}
