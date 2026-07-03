/**
 * Rotating weather city for the hourly idents: a shuffled deck of major
 * cities, drawn one per hour, persisted to the feed dir so bot redeploys
 * don't reshuffle mid-cycle. Nothing repeats until the whole deck has aired
 * (~3.5 days), then it reshuffles.
 */

import { readFile, writeFile } from 'node:fs/promises';

export interface City {
  name: string;
  lat: number;
  lon: number;
}

export const CITIES: City[] = [
  // US
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles', lat: 34.05, lon: -118.24 },
  { name: 'Chicago', lat: 41.88, lon: -87.63 },
  { name: 'Houston', lat: 29.76, lon: -95.37 },
  { name: 'Phoenix', lat: 33.45, lon: -112.07 },
  { name: 'Philadelphia', lat: 39.95, lon: -75.17 },
  { name: 'San Antonio', lat: 29.42, lon: -98.49 },
  { name: 'San Diego', lat: 32.72, lon: -117.16 },
  { name: 'Dallas', lat: 32.78, lon: -96.8 },
  { name: 'Austin', lat: 30.27, lon: -97.74 },
  { name: 'San Francisco', lat: 37.77, lon: -122.42 },
  { name: 'Seattle', lat: 47.61, lon: -122.33 },
  { name: 'Denver', lat: 39.74, lon: -104.99 },
  { name: 'Boston', lat: 42.36, lon: -71.06 },
  { name: 'Miami', lat: 25.76, lon: -80.19 },
  { name: 'Atlanta', lat: 33.75, lon: -84.39 },
  { name: 'New Orleans', lat: 29.95, lon: -90.07 },
  { name: 'Portland', lat: 45.52, lon: -122.68 },
  { name: 'Las Vegas', lat: 36.17, lon: -115.14 },
  { name: 'Detroit', lat: 42.33, lon: -83.05 },
  { name: 'Minneapolis', lat: 44.98, lon: -93.27 },
  { name: 'Nashville', lat: 36.16, lon: -86.78 },
  { name: 'Memphis', lat: 35.15, lon: -90.05 },
  { name: 'Kansas City', lat: 39.1, lon: -94.58 },
  { name: 'St. Louis', lat: 38.63, lon: -90.2 },
  { name: 'Salt Lake City', lat: 40.76, lon: -111.89 },
  { name: 'Anchorage', lat: 61.22, lon: -149.9 },
  { name: 'Honolulu', lat: 21.31, lon: -157.86 },
  { name: 'Washington, D.C.', lat: 38.91, lon: -77.04 },
  { name: 'Baltimore', lat: 39.29, lon: -76.61 },
  { name: 'Pittsburgh', lat: 40.44, lon: -80.0 },
  { name: 'Cleveland', lat: 41.5, lon: -81.69 },
  { name: 'Milwaukee', lat: 43.04, lon: -87.91 },
  { name: 'Albuquerque', lat: 35.08, lon: -106.65 },
  { name: 'Tucson', lat: 32.22, lon: -110.97 },
  { name: 'Boise', lat: 43.62, lon: -116.2 },
  { name: 'Buffalo', lat: 42.89, lon: -78.88 },
  { name: 'Charlotte', lat: 35.23, lon: -80.84 },
  { name: 'Oklahoma City', lat: 35.47, lon: -97.52 },
  { name: 'El Paso', lat: 31.76, lon: -106.49 },
  // Americas
  { name: 'Toronto', lat: 43.65, lon: -79.38 },
  { name: 'Vancouver', lat: 49.28, lon: -123.12 },
  { name: 'Montreal', lat: 45.5, lon: -73.57 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13 },
  { name: 'Guadalajara', lat: 20.67, lon: -103.35 },
  { name: 'Havana', lat: 23.11, lon: -82.37 },
  { name: 'Bogota', lat: 4.71, lon: -74.07 },
  { name: 'Lima', lat: -12.05, lon: -77.04 },
  { name: 'Santiago', lat: -33.45, lon: -70.67 },
  { name: 'Buenos Aires', lat: -34.6, lon: -58.38 },
  { name: 'Sao Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Rio de Janeiro', lat: -22.91, lon: -43.17 },
  // Europe
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Paris', lat: 48.86, lon: 2.35 },
  { name: 'Berlin', lat: 52.52, lon: 13.41 },
  { name: 'Madrid', lat: 40.42, lon: -3.7 },
  { name: 'Barcelona', lat: 41.39, lon: 2.17 },
  { name: 'Rome', lat: 41.9, lon: 12.5 },
  { name: 'Amsterdam', lat: 52.37, lon: 4.9 },
  { name: 'Vienna', lat: 48.21, lon: 16.37 },
  { name: 'Prague', lat: 50.08, lon: 14.44 },
  { name: 'Lisbon', lat: 38.72, lon: -9.14 },
  { name: 'Dublin', lat: 53.35, lon: -6.26 },
  { name: 'Edinburgh', lat: 55.95, lon: -3.19 },
  { name: 'Stockholm', lat: 59.33, lon: 18.07 },
  { name: 'Oslo', lat: 59.91, lon: 10.75 },
  { name: 'Copenhagen', lat: 55.68, lon: 12.57 },
  { name: 'Helsinki', lat: 60.17, lon: 24.94 },
  { name: 'Reykjavik', lat: 64.15, lon: -21.94 },
  { name: 'Warsaw', lat: 52.23, lon: 21.01 },
  { name: 'Budapest', lat: 47.5, lon: 19.04 },
  { name: 'Athens', lat: 37.98, lon: 23.73 },
  { name: 'Istanbul', lat: 41.01, lon: 28.98 },
  // Africa & Middle East
  { name: 'Cairo', lat: 30.04, lon: 31.24 },
  { name: 'Casablanca', lat: 33.57, lon: -7.59 },
  { name: 'Lagos', lat: 6.52, lon: 3.38 },
  { name: 'Nairobi', lat: -1.29, lon: 36.82 },
  { name: 'Cape Town', lat: -33.92, lon: 18.42 },
  { name: 'Dubai', lat: 25.2, lon: 55.27 },
  { name: 'Tel Aviv', lat: 32.09, lon: 34.78 },
  // Asia & Oceania
  { name: 'Mumbai', lat: 19.08, lon: 72.88 },
  { name: 'New Delhi', lat: 28.61, lon: 77.21 },
  { name: 'Bangkok', lat: 13.76, lon: 100.5 },
  { name: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Hong Kong', lat: 22.32, lon: 114.17 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Osaka', lat: 34.69, lon: 135.5 },
  { name: 'Seoul', lat: 37.57, lon: 126.98 },
  { name: 'Beijing', lat: 39.9, lon: 116.41 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47 },
  { name: 'Taipei', lat: 25.03, lon: 121.57 },
  { name: 'Manila', lat: 14.6, lon: 120.98 },
  { name: 'Jakarta', lat: -6.21, lon: 106.85 },
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne', lat: -37.81, lon: 144.96 },
  { name: 'Auckland', lat: -36.85, lon: 174.76 },
];

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Shuffled deck of city names; draw one per hour, reshuffle when empty. */
export class CityDeck {
  private deck: string[] | null = null;

  constructor(private readonly stateFile: string) {}

  async next(): Promise<City> {
    if (this.deck === null) {
      this.deck = [];
      try {
        const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as string[];
        // Ignore stale entries if the city list changed between deploys.
        this.deck = saved.filter((name) => CITIES.some((c) => c.name === name));
      } catch { /* fresh deck below */ }
    }
    if (this.deck.length === 0) this.deck = shuffle(CITIES.map((c) => c.name));
    const name = this.deck.shift()!;
    if (this.stateFile) {
      await writeFile(this.stateFile, JSON.stringify(this.deck), 'utf8').catch(() => {});
    }
    return CITIES.find((c) => c.name === name) ?? CITIES[0]!;
  }
}

/** Current conditions via open-meteo (keyless), e.g. "63 degrees and foggy". */
export async function fetchWeather(city: City): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
    const temp = data.current?.temperature_2m;
    if (temp === undefined) return null;
    const code = data.current?.weather_code ?? 0;
    const sky =
      code === 0 ? 'clear' :
      code <= 2 ? 'partly cloudy' :
      code === 3 ? 'overcast' :
      code <= 48 ? 'foggy' :
      code <= 67 ? 'rainy' :
      code <= 77 ? 'snowy' :
      code <= 82 ? 'showers' : 'stormy';
    return `${Math.round(temp)} degrees and ${sky}`;
  } catch {
    return null;
  }
}
