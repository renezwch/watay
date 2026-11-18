"""
LIVE PRODUCTION DEMO (Python 3.10+): SBB Swiss Public Transport API (transport.opendata.ch)

Imports the autonomously generated Python SDK (0 external dependencies, dataclasses + urllib)
and executes live internet queries against https://transport.opendata.ch with runtime validation.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "generated" / "sbb-transport" / "python"))

from sbb_swiss_public_transport_api_sdk import SbbSwissPublicTransportApiClient


def main() -> None:
    sbb = SbbSwissPublicTransportApiClient(
        base_url="https://transport.opendata.ch",
        validate_responses=True,
    )

    print("======================================================================")
    print(" 🇨🇭 SBB Live-Projekt: Python SDK (Generiert & Verifiziert mit Watay)")
    print("    Endpoint: https://transport.opendata.ch (Live Internet Request)")
    print("======================================================================\n")

    conn_res = sbb.get_connections(from_="Basel SBB", to="Luzern", limit=3)
    print("Live-Zugverbindungen Basel SBB -> Luzern (sbb.get_connections):")
    for c in conn_res.connections:
        dep_time = (c.from_.departure or "")[11:16]
        arr_time = (c.to.arrival or "")[11:16]
        trains = " -> ".join(c.products or [])
        print(
            f"   - Ab {c.from_.station.name} {dep_time} (Gleis {c.from_.platform or '-'}) "
            f"-> An {c.to.station.name} {arr_time} | Dauer: {c.duration} | Züge: [{trains}]"
        )

    print("\n✅ Live-SBB-Abfrage erfolgreich über das generierte Python-SDK ausgeführt (inkl. from_ -> 'from' Wire-Mapping & Schema-Validierung)!")


if __name__ == "__main__":
    main()
