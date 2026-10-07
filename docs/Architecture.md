# TwinFactory Labs – Architecture Overview

## High‑Level Block Diagram
```
Sensors/PLCs (OPC‑UA, MQTT, Modbus)  →  Data Sync Service  →  Twin Engine (Unity/Unreal)  →  Visualization UI (Web/VR)
                                         ↘︎                        ↘︎
                                      Analytics Service (Python/ML)   API Gateway
```

## Core Components

| Component | Primary Technology | Responsibilities |
|-----------|-------------------|------------------|
| **Data Sync Service** | **Node.js + NestJS** (or Go) + OPC‑UA, MQTT libraries | • Ingest real‑time industrial protocols.<br>• Normalize data to a common schema (JSON/Proto).<br>• Provide a streaming API (WebSocket/GRPC) to downstream services. |
| **Twin Engine** | **Unity (C#) or Unreal (C++)** – headless mode for server‑side simulation | • Maintains a 3‑D representation of the factory layout.<br>• Updates entity states (machine status, conveyor speed, temperature) in real time from the Data Sync Service.<br>• Exposes a remote rendering API (gRPC/WebSocket) for UI clients. |
| **Visualization/UI** | **React (Vite) + Three.js / Babylon.js** (fallback) + optional WebXR | • Dashboard showing live twin, KPI charts, and what‑if controls.<br>• Allows users to pause, edit parameters, and run simulation scenarios.<br>• Supports VR/AR headsets for immersive training. |
| **Optimization & Analytics** | **Python 3.11 + TensorFlow / PyTorch** | • Predictive maintenance models, bottleneck detection, and schedule optimisation.<br>• Provides a REST endpoint that the UI can call to run "what‑if" analyses. |
| **API Gateway** | **FastAPI** (Python) or **NestJS** (Node) | • Auth & tenancy management (per‑factory).<br>• Exposes unified REST/GraphQL APIs for the UI and external integrators. |
| **Auth & Multi‑Tenant** | **Keycloak** (OpenID Connect) | • Handles user login, role‑based access, and SSO with corporate identity providers. |
| **Persistence** | **PostgreSQL** (metadata) + **TimescaleDB** (time‑series sensor data) + **Object Storage (MinIO / GCS)** for 3‑D assets | • Stores plant configuration, simulation assets, and historical sensor streams. |

## Deployment Options
- **Cloud SaaS** – Kubernetes cluster (EKS/GKE) running all services.  GPU nodes for the Twin Engine (Unity headless).<br>- **Edge/On‑Prem** – Docker‑Compose with optional GPU for the engine, useful for factories with strict data‑privacy.

## Data Flow Example (What‑If Scenario)
1. Engineer changes a conveyor speed in the UI.
2. UI sends an update via WebSocket to the Twin Engine.
3. Twin Engine recomputes downstream machine states.
4. Updated state streams to the Data Sync Service → persists to TimescaleDB.
5. Analytics Service reads the new time‑series, runs optimisation model, returns KPI impact.
6. UI visualises the result in real time.

---
*All component specifications, API contracts, and Docker compose files are located in the `TwinFactoryDocs/Specs` sub‑folder.*
