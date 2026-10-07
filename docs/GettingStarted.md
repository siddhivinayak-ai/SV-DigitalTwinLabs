# Getting Started – TwinFactory Labs

This guide walks you through setting up a **free, open‑source development environment** to prototype a digital‑twin platform for a manufacturing floor. All steps assume a Windows host (the user’s OS) with Docker Desktop installed.

---
## Prerequisites
| Tool | Installation Link |
|------|-------------------|
| **Git** | https://git-scm.com/download/win |
| **Docker Desktop** (WSL2 backend) | https://www.docker.com/products/docker-desktop |
| **Node.js 20 LTS** | https://nodejs.org/en/download |
| **Python 3.11** (with `pip`) | https://www.python.org/downloads/windows/ |
| **Unity Hub (Free)** – for the Twin Engine | https://unity.com/download |
| **VS Code** (optional) | https://code.visualstudio.com/ |

---
## 1️⃣ Clone the Repository Skeleton
```bash
# Create a workspace folder
mkdir TwinFactory && cd TwinFactory

# Clone the starter mono‑repo (this doc’s skeleton) – replace with your own remote if you fork
git clone https://github.com/your-org/twinfactory-starter.git .
```
The skeleton contains the folder structure:
```
TwinFactory/
├─ docs/                # Documentation (Concept, Architecture, …)
├─ services/            # Docker compose for all micro‑services
│   ├─ data-sync/       # Node.js NestJS service
│   ├─ analytics/       # Python ML service
│   └─ api-gateway/     # FastAPI gateway
├─ twin-engine/         # Unity project (headless server build)
├─ ui/                  # React‑Vite web dashboard
└─ infra/               # Terraform/K8s manifests (optional)
```

---
## 2️⃣ Spin Up Backend Services (Docker‑Compose)
```bash
cd services
docker compose up -d
```
The compose file starts:
- `data-sync` (exposes port 4000, WS endpoint `/ws`)
- `analytics` (port 5000, REST `/predict`)
- `api-gateway` (port 8000, auth via Keycloak)
- `postgres` + `timescaledb`
- `minio` for object storage

> **Tip**: Use `docker compose logs -f` to watch startup logs.

---
## 3️⃣ Build the Twin Engine (Unity)
1. Open **Unity Hub** → **Add** the `twin-engine` folder.
2. Install the **Linux Headless Build Support** (or Windows if you prefer GPU).
3. Open `TwinEngine.unity` and press **File → Build Settings**.
4. Add the `TwinEngine` scene, select **Linux Server** (or Windows), click **Build** → `build/engine_server`.
5. Run the server:
```bash
cd twin-engine/build
./engine_server --port 9000
```
The engine will connect to the Data Sync Service via the WebSocket URL `ws://localhost:4000/ws`.

---
## 4️⃣ Run the Web Dashboard
```bash
cd ui
npm install
npm run dev   # Vite dev server on http://localhost:5173
```
Log in with the default Keycloak demo account (admin/admin) – it is pre‑configured in the Docker compose.

---
## 5️⃣ Simulate a Simple Factory
The starter includes a sample **JSON plant model** (`sample_plant.json`) that defines:
- Machines (ID, type, position)
- Conveyors (speed, endpoints)
- Sensors (temperature, vibration)

1. Upload the model via the UI → **Plant > Import**.
2. The Data Sync Service will emit synthetic sensor streams (you can replace with real OPC‑UA endpoints later).
3. Use the **What‑If** panel to change conveyor speed and see the twin update in real time.

---
## 6️⃣ Extend / Contribute
- Add new **OPC‑UA** connectors in `services/data-sync/src/opcua/`.
- Implement additional **ML models** in `services/analytics/models/` and expose them from the REST API.
- Contribute UI components under `ui/src/components/`.
- Deploy to cloud via the provided `infra/k8s/` manifests (requires a K8s cluster with GPU nodes).

---
## 7️⃣ Clean Up
```bash
# Stop all containers
docker compose down
# Remove Unity build artifacts if not needed
rm -rf twin-engine/build
```

---
**Next Steps**: Review `docs/RepoReferences.md` for a curated list of open‑source projects you can combine to enrich the platform (physics engines, CAD import, protocol stacks, etc.).

---
*All documentation lives under the `docs/` folder of the repository. Feel free to edit or expand as your project evolves.*
