/**
 * LIVE PRODUCTION DEMO: SBB Swiss Public Transport API (transport.opendata.ch)
 *
 * Uses the autonomously generated TypeScript SDK from:
 *   ./generated/sbb-transport/typescript/src/index.ts
 *
 * Makes REAL live HTTP requests over the internet to https://transport.opendata.ch
 * and validates the real SBB timetable payloads against the generated runtime schema guard!
 */
import { SbbSwissPublicTransportApiClient } from './generated/sbb-transport/typescript/src/index.ts';

async function main(): Promise<void> {
  const sbb = new SbbSwissPublicTransportApiClient({
    baseUrl: 'https://transport.opendata.ch',
    validateResponses: true,
  });

  console.log('======================================================================');
  console.log(' 🇨🇭 SBB Live-Projekt: TypeScript SDK (Generiert & Verifiziert mit Watay)');
  console.log('    Endpoint: https://transport.opendata.ch (Live Internet Request)');
  console.log('======================================================================\n');

  // 1. Live Station Search (/v1/locations)
  console.log('1) Suche SBB-Stationen für "Zürich HB" (sbb.searchLocations)...');
  const locRes = await sbb.searchLocations({ query: 'Zürich HB', type: 'station' });
  for (const st of locRes.stations.slice(0, 3)) {
    console.log(
      `   - ${st.name} (UIC-ID: ${st.id}) | WGS84: [${st.coordinate?.x}, ${st.coordinate?.y}]`
    );
  }

  // 2. Live Train Connections Zürich HB -> Bern (/v1/connections)
  console.log('\n2) Nächste Live-Zugverbindungen Zürich HB -> Bern (sbb.getConnections)...');
  const connRes = await sbb.getConnections({
    from: 'Zürich HB',
    to: 'Bern',
    limit: 3,
  });
  for (const c of connRes.connections) {
    const depTime = c.from.departure?.slice(11, 16) ?? '??:??';
    const arrTime = c.to.arrival?.slice(11, 16) ?? '??:??';
    const delayStr = c.from.delay && c.from.delay > 0 ? `+${c.from.delay} min` : 'pünktlich';
    const trains = (c.products ?? []).join(' -> ');
    console.log(
      `   - Ab ${c.from.station.name} ${depTime} (Gleis ${c.from.platform ?? '-'}, ${delayStr}) ` +
        `-> An ${c.to.station.name} ${arrTime} | Dauer: ${c.duration} | Züge: [${trains}]`
    );
  }

  // 3. Live Departure Board / Abfahrtstafel Zürich HB (/v1/stationboard)
  console.log('\n3) Live-Abfahrtstafel Zürich HB (sbb.getStationboard)...');
  const boardRes = await sbb.getStationboard({
    station: 'Zürich HB',
    limit: 4,
  });
  for (const j of boardRes.stationboard) {
    const time = j.stop.departure?.slice(11, 16) ?? '??:??';
    console.log(
      `   - [${time}] ${j.name.padEnd(8)} -> ${j.to.padEnd(22)} (Gleis ${j.stop.platform ?? '-'})`
    );
  }

  console.log('\n✅ Alle 3 Live-SBB-Abfragen erfolgreich über das generierte TypeScript-SDK ausgeführt & Schema-validiert!');
}

main().catch((err) => {
  console.error('SBB Live Demo Error:', err);
  process.exit(1);
});
