# Watay – Technische Architektur-Spezifikation (MVP v0.1)

**Autor:** `architect` · **Status:** verbindlich für `dev-core`, `dev-codegen`, `dev-action`, `critic`
**Produkt:** Watay (`watay.io`, `npx watay`) – Multi-Language-SDK-Generierung, SpecDrift (semantische Breaking-Change-Erkennung), Contract-Tests, Self-Healing. **100 % client-side** (CLI + GitHub Action), Zero-Data-Retention.

---

## 1. Harte Umgebungs-Constraints (verifiziert auf dieser Maschine)

| Fakt | Konsequenz |
| :-- | :-- |
| Node **v26** vorhanden, **kein `npm`, kein `tsc`, kein `tsx`**, keine Netzwerk-Installs | **Zero Runtime-Dependencies.** Nur Node-Builtins (`node:fs`, `node:path`, `node:util`, `node:test`, `node:assert`, `node:child_process`, `node:crypto`, `node:module`). |
| Node führt `.ts` nativ aus (Type-Stripping) | Code darf nur **"erasable syntax"** nutzen: **kein `enum`, kein `namespace`, keine Parameter-Properties (`constructor(private x)`), kein `import x = require`.** Nur `import type` für Typen. |
| Relative Imports | **Immer mit `.ts`-Endung**: `import { parseSpec } from "../core/parser.ts"`. Typen: `import type { WatayIR } from "../types.ts"`. |
| `package.json` | `"type": "module"`, `"bin": { "watay": "./src/cli/index.ts" }` (Shebang `#!/usr/bin/env node`), Scripts: `"test": "node --test tests/"`. Keine `dependencies`. |
| Tests | `node --test tests/` (builtin `node:test` + `node:assert/strict`). |
| Python 3.14 vorhanden, **kein pydantic** | Python-SDK nutzt **`dataclasses` + stdlib `urllib`** (keine Fremdpakete) → vollständig in der Sandbox verifizierbar (`python3 -m py_compile`, Ausführung gegen lokalen Mock-Server). Pydantic-Variante optional als `--python-style pydantic` (nur Codegen, nicht ausführbar getestet). |
| Kein `tsc` | TS-Verifikation des generierten SDK: (a) `module.stripTypeScriptTypes()` / `node --check` auf gestripptem Code (Syntax), (b) Laufzeit-Test gegen lokalen `node:http`-Mock-Server (Verhalten), (c) optional `tsc --noEmit`, **falls** vorhanden (Feature-Detect, sonst `skipped`, nie `failed`). |
| YAML | Kein js-yaml. `parser.ts` unterstützt **JSON voll**; YAML über einen eingebauten Mini-Parser für die in OpenAPI übliche Teilmenge (Maps, Listen, Skalare, Block-Strings, Flow-`[]`/`{}`) – im MVP darf YAML-Komplexität (Anchors/Tags) mit klarer Fehlermeldung abgelehnt werden. |

---

## 2. Modulgrenzen & Eigentümer

```
products/watay/
├── package.json, tsconfig.json          dev-core
├── ARCHITECTURE.md                      architect
├── src/
│   ├── types.ts                         dev-core  (Kontrakt unten, Änderungen nur per Board-Absprache)
│   ├── core/parser.ts                   dev-core   spec → WatayIR
│   ├── core/differ.ts                   dev-core   (IR, IR) → DiffResult (+ Markdown)
│   ├── cli/index.ts                     dev-core   diff | generate | verify | (license)
│   ├── generators/typescript.ts         dev-codegen
│   ├── generators/python.ts             dev-codegen
│   ├── generators/contract-tests.ts     dev-codegen
│   ├── healer/self-heal.ts              dev-codegen
│   ├── action/license.ts                dev-action
│   └── action/runner.ts                 dev-action
├── action.yml, README.md, docs/         dev-action
├── examples/ , tests/core.test.ts       dev-core
└── tests/codegen.test.ts                dev-codegen
```

Abhängigkeitsrichtung (keine Zyklen): `types` ← `core` ← `generators` ← `healer` ← `cli` / `action`. `generators` und `healer` importieren **nie** aus `cli` oder `action`. `cli` verdrahtet alles.

---

## 3. Verbindlicher Daten-Kontrakt

**Single Source of Truth ist [`src/types.ts`](src/types.ts) (Owner `dev-core`)**; Änderungen nur additiv und per Board-Post angekündigt. Kernpunkte, auf die sich alle Module verlassen:

- `WatayIR { title, version, description?, servers, schemas, operations }` – `operations` sortiert nach path, dann method; `SchemaIR.ref` = Komponentenname (`"Pet"`, nicht `#/components/...`).
- `OperationIR.responses: Record<string, ResponseIR>` (Keys `"200"`, `"404"`, `"default"`, sortiert); Parameter path-level + op-level gemerged.
- `DiffResult { breaking, nonBreaking, info, hasBreaking, suggestedBump: major|minor|patch, markdown }` (`DiffChange { code, severity, location, message, before?, after? }`).
- `GeneratorOutput { language: "typescript"|"python", files: Record<relPath, content> }` – Generatoren **rein, deterministisch**.
- `VerifyIssue / VerifyReport / HealOptions / HealResult` (BYOK-Hook `repair(files, issues) => Promise<files>`), `Tier`, `LicenseStatus { valid, tier, source, reason?, expiresAt? }`.
- `WatayError(message, code)` in `src/errors.ts`.

**Public API je Modul (verbindlich; Abweichungen bitte auf dem Board posten):**

| Modul | Export |
| :-- | :-- |
| `core/parser.ts` | `parseSpec(text, hint?): WatayIR` · `loadSpecFile(path): WatayIR` (wirft `WatayError` mit actionable Meldung bei ungültiger Spec / unaufgelöstem `$ref`) |
| `core/differ.ts` | `diffSpecs(oldIr, newIr): DiffResult` |
| `generators/typescript.ts` | `generateTypeScript(ir, opts?: { packageName?: string }): GeneratorOutput` |
| `generators/python.ts` | `generatePython(ir, opts?: { packageName?: string }): GeneratorOutput` |
| `generators/contract-tests.ts` | `generateContractTests(ir, lang): Record<string,string>` (Tests laufen gegen **eingebauten Mock-Server**, der aus der IR Beispielantworten synthetisiert) |
| `healer/self-heal.ts` | `verifyOutput(out): Promise<VerifyReport>` · `selfHeal(out, opts?): Promise<HealResult>` |
| `action/license.ts` | `checkLicense(key, env?): Promise<LicenseStatus>` · `tierAllows(tier, feature): boolean` |
| `action/runner.ts` | `runAction(env): Promise<number>` (Exit-Code) |

---

## 4. Verhalten & Qualitätsregeln

1. **Determinismus (Pflicht):** Gleiche Eingabe-Spec → byte-identische Ausgabe (kein Datum, keine Zufallswerte, sortierte Keys). Das ist die Voraussetzung für saubere Diffs in Kunden-PRs und für Snapshot-Tests.
2. **Deterministisch zuerst, LLM zuletzt:** Generierung ist reine Template-/AST-Logik. LLM (BYOK) greift **nur** im `repair`-Hook von `selfHeal` ein, nie in der Standard-Generierung. Ohne API-Key funktioniert 100 % des Produkts (Free-Tier-Garantie).
3. **Breaking-Change-Regeln (Minimum für `differ.ts`):**
   *breaking:* Operation (Pfad/Methode) entfernt · neuer **required** Parameter · Parameter-Typ geändert · Pfad-Parameter entfernt/umbenannt · neues **required** Request-Body-Property · Request-Property-Typ verengt · Request-Body optional→required · Response-Property entfernt · Response-Property-Typ geändert · Response-Property wird `nullable` · Enum-Wert in **Request** entfernt · Enum-Wert in **Response** hinzugefügt (für Clients mit exhaustive switch riskant → `non-breaking` mit Warn-Hinweis in `message`) · Erfolgs-Statuscode (2xx) entfernt · Security-Requirement neu hinzugefügt.
   *non-breaking:* neue Operation · neuer optionaler Parameter · neues optionales Request-Property · neues Response-Property · neuer Response-Statuscode · Deprecation-Markierung (`info`).
   Richtungsbewusst (Request vs. Response, "contravariant/covariant") – nicht nur Textvergleich.
4. **Fehlerkultur:** Exit-Codes CLI: `0` ok, `1` Breaking Changes gefunden (`watay diff --fail-on-breaking`), `2` Eingabe-/Spec-Fehler, `3` Verify-Fehler, `4` Lizenz-/Tier-Verstoß (nur wenn Feature explizit gesperrt). Meldungen immer actionable.
5. **Lizenz-Design (Free-Tier nie brechen):** Netzwerkfehler/ungültiger Key ⇒ **Fallback auf `free`**, niemals Absturz. Pro/Scale schalten *Mengen/Automation* frei (mehr Sprachen, Auto-PR, Auto-Publish, Breaking-Change-Blocker), nicht die Kernfunktion. Offline-Demo-Key `WATAY-DEMO-PRO` → `pro`, `source:"offline-demo"` (für Tests & Showcase).
6. **Security (Zero-Data-Retention):** Specs, Quellcode, LLM-Prompts verlassen den Runner **nie** Richtung TestInc. Einziger ausgehender TestInc-/Provider-Call: Lizenzprüfung (nur Key-Hash + Produkt-ID). Keine Telemetrie. Keine Secrets in Logs (Key maskiert `WATAY-****abcd`). Vgl. `knowhow/architecture/zero-data-retention-ci-actions.md`.
7. **Pfad-Sicherheit Generatoren:** `GeneratorOutput.files`-Keys sind relative POSIX-Pfade ohne `..`/Absolutpfad; `cli generate --out` schreibt nur darunter (Path-Traversal-Test Pflicht).
8. **Identifier-Hygiene:** Namen aus Specs (operationId, Property-Namen) werden in valide Identifier der Zielsprache normalisiert, Reservierte Wörter (`class`, `from`, `import`, `delete` …) escaped, Kollisionen eindeutig gemacht (Suffix `2`), Original-Name bleibt im Wire-Format erhalten (Mapping, z. B. Python `from_` ↔ `"from"`).

---

## 5. Teststrategie (Definition of Done je Modul)

| Ebene | Was | Wer |
| :-- | :-- | :-- |
| Unit | Parser (JSON+YAML, `$ref`, allOf), Differ (≥ 15 Regeln, request/response-Richtung), Identifier-Escaping | dev-core |
| Snapshot/Golden | Generator-Output für `examples/petstore-v1.json` stabil & deterministisch (2× generieren → identisch) | dev-codegen |
| **Execution** | Generiertes **TS-SDK läuft** gegen lokalen Mock-Server (`node`), generiertes **Python-SDK läuft** gegen denselben (`python3`); Contract-Tests grün | dev-codegen / critic |
| Self-Heal | Absichtlich zerstörtes SDK (Syntaxfehler) wird via `repair`-Hook-Stub repariert → `healed:true`; ohne Hook → ehrlicher `failed`-Report | dev-codegen |
| CLI E2E | `watay diff v1 v2-breaking` → Exit 1 + Markdown; `generate --lang ts,python --out tmp` → Dateien existieren & `verify` grün; Path-Traversal blockiert | critic |
| Lizenz | Kein Key → free; Demo-Key → pro; Netzwerk tot → free-Fallback (kein Throw); Key nie im Log | dev-action / critic |
| Action | `runAction` mit gefaketer `GITHUB_EVENT_PATH`/Env im Dry-Run (`WATAY_DRY_RUN=1`): kommentiert (stdout-Markdown), setzt Exit-Code korrekt | dev-action / critic |

`critic` führt alles real aus: `cd products/watay && node --test tests/` und die CLI-Kommandos; rote Tests gehen an den Owner zurück.

---

## 6. GitHub-Action-Architektur (Client-Side)

```
PR öffnet/ändert OpenAPI-Spec
   └─> kundeneigener Runner: uses: testinc/watay@v1  (Composite Action: node src/action/runner.ts)
         1. checkLicense(WATAY_LICENSE_KEY)      ← einziger Outbound-Call (LemonSqueezy/Polar License API)
         2. baseSpec = `git show origin/<base>:<specPath>`   (lokal, kein API-Zugriff nötig)
         3. diffSpecs(base, head)  → Markdown-PR-Kommentar (GITHUB_TOKEN des Kunden) / Step-Summary
         4. fail-on-breaking (Pro: konfigurierbar, mit Label-Override `watay-allow-breaking`)
         5. generate SDKs → verify/selfHeal → (Pro) commit/PR in SDK-Repo · (Scale) npm/PyPI publish mit Kunden-Tokens
```
`action.yml` = **composite** (`using: composite`, Step `run: node "${{ github.action_path }}/src/action/runner.ts"`) – kein Docker, kein Build-Schritt, Startzeit < 2 s. Berechtigungen minimal (`contents: read`, `pull-requests: write`).

---

## 7. Roadmap nach MVP (nicht jetzt bauen)
Go/Rust-Generator · GraphQL-Eingang · signierte Template-Bundles (Ed25519, Offline-Verifikation) · Pydantic-Style · Auto-Publish-Pipeline · Showcase-SDK-Fabrik (50 APIs, `knowhow/gtm-playbooks/autonomous-devtool-gtm.md`).
