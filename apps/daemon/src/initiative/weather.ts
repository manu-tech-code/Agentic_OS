/**
 * Today's weather for the briefing, from Open-Meteo (open-meteo.com): free, no key. Only the town
 * the user set goes out - to find it, then its forecast. Places are remembered and forecasts kept
 * for a while, so a briefing asks at most twice.
 */

export interface WeatherToday {
  place: string;
  now: number;
  high: number;
  low: number;
  /** The chance of rain today, 0-100. */
  rain: number;
  sky: string;
  unit: 'C' | 'F';
}

const SKY: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle',
  55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain',
  67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow', 80: 'rain showers', 81: 'rain showers',
  82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};
const AGENT = 'Nova/0.6 (morning briefing)';
const FRESH_MS = 20 * 60_000;

type Fetch = (url: string) => Promise<unknown>;
const getJson: Fetch = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': AGENT }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  return res.json();
};

export class Weather {
  private readonly places = new Map<string, { lat: number; lon: number; name: string } | null>();
  private cache: { key: string; at: number; value: WeatherToday } | null = null;

  constructor(
    private readonly get: Fetch = getJson,
    private readonly now: () => number = Date.now,
  ) {}

  async today(town: string, units: 'celsius' | 'fahrenheit'): Promise<WeatherToday> {
    const key = `${town.trim().toLowerCase()}|${units}`;
    if (this.cache?.key === key && this.now() - this.cache.at < FRESH_MS) return this.cache.value;
    const place = await this.find(town);
    const params = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      current: 'temperature_2m,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '1',
      temperature_unit: units,
    });
    const data = (await this.get(`https://api.open-meteo.com/v1/forecast?${params}`)) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: (number | null)[] };
    };
    const current = data.current;
    if (typeof current?.temperature_2m !== 'number') throw new Error("Open-Meteo didn't send a forecast.");
    const value: WeatherToday = {
      place: place.name,
      now: Math.round(current.temperature_2m),
      high: Math.round(data.daily?.temperature_2m_max?.[0] ?? current.temperature_2m),
      low: Math.round(data.daily?.temperature_2m_min?.[0] ?? current.temperature_2m),
      rain: Math.round(data.daily?.precipitation_probability_max?.[0] ?? 0),
      sky: SKY[current.weather_code ?? -1] ?? 'unsettled',
      unit: units === 'fahrenheit' ? 'F' : 'C',
    };
    this.cache = { key, at: this.now(), value };
    return value;
  }

  private async find(town: string) {
    const key = town.trim().toLowerCase();
    if (!this.places.has(key)) {
      const params = new URLSearchParams({ name: town.trim(), count: '1', language: 'en', format: 'json' });
      const data = (await this.get(`https://geocoding-api.open-meteo.com/v1/search?${params}`)) as { results?: { latitude: number; longitude: number; name: string }[] };
      const hit = data.results?.[0];
      this.places.set(key, hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null);
    }
    const place = this.places.get(key);
    if (!place) throw new Error(`Open-Meteo doesn't know a place called "${town}".`);
    return place;
  }
}

/** "In Accra it's 29 degrees and partly cloudy - up to 31 today, with rain likely." */
export function sayWeather(w: WeatherToday) {
  const rain = w.rain >= 70 ? ', with rain likely' : w.rain >= 40 ? ', with a chance of rain' : '';
  return `In ${w.place} it's ${w.now} degrees and ${w.sky} - ${w.high > w.now ? `up to ${w.high}` : `${w.low} at the lowest`} today${rain}.`;
}
