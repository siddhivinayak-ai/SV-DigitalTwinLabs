# TwinFactory Labs – Repository References

Below is a curated list of **open‑source projects** that can be combined (by integration or fork) to assemble a feature‑rich digital‑twin platform for manufacturing. Most are permissively licensed (MIT/Apache/BSD) and have active communities.

| # | Repository | Primary Use‑Case | Language / Tech | License | Highlights |
|---|------------|------------------|-----------------|---------|------------|
| 1 | **FreeCAD** – https://github.com/FreeCAD/FreeCAD | CAD model import & editing, geometry manipulation | C++/Python | LGPL‑2.1 | Robust parametric CAD engine; can be used to load plant layouts and export meshes for Unity/Unreal. |
| 2 | **OpenFOAM** – https://github.com/OpenFOAM/OpenFOAM-dev | CFD & physics simulation of fluid/thermal processes in factories | C++ | GPL‑3.0 | Provides realistic airflow, heat, and particulate simulations for ventilation or furnace twins. |
| 3 | **ROS 2** – https://github.com/ros2/ros2 | Real‑time robotics & sensor integration, OPC‑UA bridge nodes | C++/Python | Apache‑2.0 | ROS 2‑industrial adds drivers for PLCs, Modbus, and can publish sensor data via DDS. |
| 4 | **Unity Simulation (DOTS)** – https://github.com/Unity-Technologies/EntityComponentSystemSamples | Scalable, data‑oriented 3‑D simulation engine (headless) | C# | Unity Proprietary (free tier) | Unity DOTS enables millions of entities with low CPU overhead – ideal for large factory twins. |
| 5 | **Three.js** – https://github.com/mrdoob/three.js | Web‑based 3‑D visualisation, lightweight fallback when Unity not available | JavaScript | MIT | Provides interactive twin view directly in the browser; can load GLTF meshes exported from FreeCAD. |
| 6 | **OpenAI Gym / Gymnasium** – https://github.com/Farama-Foundation/Gymnasium | Reinforcement‑learning environments for process optimisation | Python | MIT | Use as a sandbox to train AI agents for scheduling or energy optimisation on the twin. |
| 7 | **OPC-UA‑dotnet** – https://github.com/OPCFoundation/UA-.NETStandard | OPC‑UA client/server library for .NET | C# | MIT | Connects directly to PLCs and SCADA systems; can be wrapped in a Node.js service via Edge.js. |
| 8 | **MQTT‑net** – https://github.com/dotnet/MQTTnet | MQTT broker/client library for .NET (publish/subscribe) | C# | MIT | Lightweight messaging for sensor streams; alternative to OPC‑UA where devices support MQTT. |
| 9 | **Streamlit** – https://github.com/streamlit/streamlit | Quick UI front‑end for data‑science dashboards (optional for analytics) | Python | Apache‑2.0 | Build rapid analytics UI for performance insights that can be embedded in the main dashboard via iframe. |
|10| **Keycloak** – https://github.com/keycloak/keycloak | Identity & access management (OAuth2/OIDC) | Java | Apache‑2.0 | Handles multi‑tenant auth, SSO with corporate IdPs; can be run as a Docker container. |

## How to Combine Them
1. **Plant Geometry** – Model the factory layout in **FreeCAD**, export to **GLTF** or **OBJ**, and import into the **Unity DOTS** twin engine.
2. **Physical Simulation** – For fluid or thermal effects, run **OpenFOAM** simulations offline and feed results via the **Data Sync Service** to the twin.
3. **Real‑Time Data** – Use **ROS 2** nodes or **OPC‑UA‑dotnet**/`MQTT‑net` to pull live sensor data from PLCs, then publish to a central **WebSocket** endpoint.
4. **AI Optimisation** – Wrap **Gymnasium** environments around the twin engine to train RL agents; expose predictions via the **Analytics Service** (Python).
5. **Web UI** – Render the twin in the browser with **Three.js** for lightweight access, while the full‑fidelity simulation runs on Unity headless server.
6. **Auth** – Deploy **Keycloak** alongside the API gateway for secure multi‑tenant access.
7. **Analytics Dashboards** – Use **Streamlit** for experiment notebooks that analysts can run against the twin data.

### Example Integration Flow
```
FreeCAD → GLTF → Unity Engine ↔️ Data Sync Service ↔️ ROS2 / OPC-UA ↔️ Sensors
        ↕                                   ↕
    Three.js UI ←→ FastAPI Gateway ←→ Analytics (Gymnasium + Streamlit)
```

These repositories give you the building blocks for **geometry, physics, real‑time connectivity, AI, visualization, and security** – the core pillars of a modern digital‑twin platform.

---
*Feel free to fork any of these projects and adapt them to the folder layout described in the GettingStarted guide.*
