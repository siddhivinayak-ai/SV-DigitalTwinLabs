using UnityEngine;

namespace TwinLabs.Unity
{
    /// <summary>
    /// One asset in the 3D scene. Builds its own procedural geometry from the <see cref="AssetDef"/>,
    /// applies live <see cref="AssetState"/> (ISA-101 beacon colour, fault blink) and animates
    /// moving parts (spindle, robot arm, belt, inspection head) while Running.
    /// Local frame: origin at floor centre, +X = flow direction, footprint = def.Size.
    /// </summary>
    public sealed class AssetView : MonoBehaviour
    {
        public const float PartSize = 0.28f;

        public AssetDef Def { get; private set; }
        public AssetState State { get; private set; }
        public Vector3 Size { get; private set; }
        public bool Selected { get; private set; }

        Material _beaconMat;
        Material _beltMat;
        GameObject _selectionFrame;
        Transform _label;

        // machine
        Transform _spindle;
        float _partTableY;

        // robot
        Transform _turret, _shoulder, _elbow, _tool;
        float _pickYaw = 90f, _placeYaw = -90f;
        float _yaw, _shoulderAngle, _elbowAngle;

        // inspection
        Transform _camHead;

        // sink
        Transform _stack;

        // animation state
        float _beltOffset;
        float _displayProgress;
        float _sinceStateChange;

        // ================================================================= build

        public void Build(AssetDef def)
        {
            Def = def;
            Size = TwinJson.SizeToUnity(def.Size);
            name = def.Id;

            var col = gameObject.AddComponent<BoxCollider>();
            col.center = new Vector3(0, Size.y * 0.5f, 0);
            col.size = Size;

            switch (def.Kind)
            {
                case AssetKind.Conveyor: BuildConveyor(); break;
                case AssetKind.Machine: BuildMachine(); break;
                case AssetKind.Robot: BuildRobot(); break;
                case AssetKind.Buffer: BuildBuffer(); break;
                case AssetKind.Inspection: BuildInspection(); break;
                case AssetKind.Source: BuildSource(); break;
                case AssetKind.Sink: BuildSink(); break;
                default: TwinVisuals.Box("Body", transform, new Vector3(0, Size.y / 2, 0), Size, TwinVisuals.Shared(TwinVisuals.Body)); break;
            }
            BuildSelectionFrame();
            BuildLabel();
            ApplyState(new AssetState { Id = def.Id, State = AssetStateKind.Idle });
        }

        Material M(Color c) => TwinVisuals.Shared(c);

        /// <summary>Stack light: pole + lamp. The lamp material is per-asset so it can change colour.</summary>
        void Beacon(Vector3 basePos, float poleHeight)
        {
            TwinVisuals.Cyl("BeaconPole", transform, basePos, 0.04f, poleHeight, M(TwinVisuals.Frame));
            _beaconMat = TwinVisuals.NewMaterial(TwinVisuals.IdleOff, 0.8f);
            TwinVisuals.Cyl("BeaconLamp", transform, basePos + Vector3.up * poleHeight, 0.2f, 0.26f, _beaconMat);
            TwinVisuals.Cyl("BeaconCap", transform, basePos + Vector3.up * (poleHeight + 0.26f), 0.21f, 0.03f, M(TwinVisuals.Frame));
        }

        void BuildConveyor()
        {
            var s = Size;
            var h = s.y;
            var frame = M(TwinVisuals.Frame);
            var legs = Mathf.Max(2, Mathf.CeilToInt(s.x / 2f) + 1);
            for (var i = 0; i < legs; i++)
            {
                var x = Mathf.Lerp(-s.x / 2 + 0.15f, s.x / 2 - 0.15f, legs == 1 ? 0.5f : i / (float)(legs - 1));
                foreach (var z in new[] { -s.z / 2 + 0.05f, s.z / 2 - 0.05f })
                    TwinVisuals.Box("Leg", transform, new Vector3(x, (h - 0.1f) / 2, z), new Vector3(0.06f, h - 0.1f, 0.06f), frame);
            }
            TwinVisuals.Box("RailL", transform, new Vector3(0, h - 0.06f, -s.z / 2 + 0.03f), new Vector3(s.x, 0.14f, 0.06f), M(TwinVisuals.Body));
            TwinVisuals.Box("RailR", transform, new Vector3(0, h - 0.06f, s.z / 2 - 0.03f), new Vector3(s.x, 0.14f, 0.06f), M(TwinVisuals.Body));
            TwinVisuals.Box("Bed", transform, new Vector3(0, h - 0.08f, 0), new Vector3(s.x, 0.08f, s.z - 0.12f), frame);

            _beltMat = TwinVisuals.NewMaterial(TwinVisuals.Belt, 0.1f);
            TwinVisuals.SetTexture(_beltMat, TwinVisuals.StripeTexture, new Vector2(s.x / 0.25f, 1f));
            TwinVisuals.Box("Belt", transform, new Vector3(0, h - 0.02f, 0), new Vector3(s.x - 0.1f, 0.02f, s.z - 0.14f), _beltMat);

            var roller = Quaternion.Euler(90, 0, 0);
            foreach (var x in new[] { -s.x / 2 + 0.06f, s.x / 2 - 0.06f })
                TwinVisuals.Prim(PrimitiveType.Cylinder, "Roller", transform, new Vector3(x, h - 0.05f, 0), new Vector3(0.12f, (s.z - 0.12f) / 2, 0.12f), M(TwinVisuals.BodyDark), roller);

            TwinVisuals.Box("Drive", transform, new Vector3(s.x / 2 - 0.25f, h * 0.45f, -s.z / 2 - 0.12f), new Vector3(0.3f, 0.3f, 0.22f), M(TwinVisuals.BodyDark));
            Beacon(new Vector3(-s.x / 2 + 0.1f, h, -s.z / 2 - 0.05f), 0.45f);
        }

        void BuildMachine()
        {
            var s = Size;
            var bedH = s.y * 0.38f;
            TwinVisuals.Box("Bed", transform, new Vector3(0, bedH / 2, 0), new Vector3(s.x, bedH, s.z), M(TwinVisuals.Body));
            TwinVisuals.Box("Plinth", transform, new Vector3(0, 0.04f, 0), new Vector3(s.x + 0.08f, 0.08f, s.z + 0.08f), M(TwinVisuals.Frame));
            TwinVisuals.Box("Table", transform, new Vector3(0, bedH + 0.03f, -s.z * 0.05f), new Vector3(s.x * 0.6f, 0.06f, s.z * 0.55f), M(TwinVisuals.BodyDark));
            _partTableY = bedH + 0.06f;

            var colH = s.y - bedH;
            var colZ = s.z * 0.33f;
            TwinVisuals.Box("Column", transform, new Vector3(0, bedH + colH / 2, colZ), new Vector3(s.x * 0.32f, colH, s.z * 0.3f), M(TwinVisuals.Body));
            var headH = s.y * 0.16f;
            var headY = s.y - headH / 2 - 0.05f;
            TwinVisuals.Box("Head", transform, new Vector3(0, headY, colZ - s.z * 0.28f), new Vector3(s.x * 0.28f, headH, s.z * 0.5f), M(TwinVisuals.Body));

            // Spindle hangs under the head, over the table. Fin makes rotation visible.
            var spindleLen = Mathf.Max(0.15f, headY - headH / 2 - (_partTableY + PartSize + 0.1f));
            _spindle = TwinVisuals.Pivot("Spindle", transform, new Vector3(0, headY - headH / 2, -s.z * 0.05f));
            TwinVisuals.Prim(PrimitiveType.Cylinder, "Shaft", _spindle, new Vector3(0, -spindleLen / 2, 0), new Vector3(0.16f, spindleLen / 2, 0.16f), M(TwinVisuals.BodyDark));
            TwinVisuals.Box("Fin", _spindle, new Vector3(0.07f, -spindleLen * 0.35f, 0), new Vector3(0.1f, spindleLen * 0.4f, 0.03f), M(TwinVisuals.Amber * 0.8f));
            TwinVisuals.Prim(PrimitiveType.Cylinder, "Tool", _spindle, new Vector3(0, -spindleLen - 0.05f, 0), new Vector3(0.05f, 0.05f, 0.05f), M(TwinVisuals.PartColor));

            TwinVisuals.Box("Cabinet", transform, new Vector3(s.x / 2 - s.x * 0.08f, bedH + s.y * 0.25f, colZ), new Vector3(s.x * 0.14f, s.y * 0.5f, s.z * 0.3f), M(TwinVisuals.BodyDark));
            TwinVisuals.Box("Panel", transform, new Vector3(s.x / 2 + 0.06f, bedH + 0.45f, -s.z * 0.25f), new Vector3(0.08f, 0.5f, 0.4f), M(TwinVisuals.Glass));
            Beacon(new Vector3(-s.x * 0.12f, s.y, colZ + s.z * 0.1f), 0.25f);
        }

        void BuildRobot()
        {
            var s = Size;
            var baseD = Mathf.Min(s.x, s.z) * 0.75f;
            TwinVisuals.Box("Pedestal", transform, new Vector3(0, 0.15f, 0), new Vector3(s.x, 0.3f, s.z), M(TwinVisuals.Frame));
            TwinVisuals.Cyl("Base", transform, new Vector3(0, 0.3f, 0), baseD, 0.2f, M(TwinVisuals.Body));

            var arm = M(TwinVisuals.Hex("#C9C6BC"));
            var joint = M(TwinVisuals.BodyDark);
            _turret = TwinVisuals.Pivot("Turret", transform, new Vector3(0, 0.5f, 0));
            TwinVisuals.Cyl("TurretBody", _turret, Vector3.zero, baseD * 0.7f, 0.3f, arm);

            var l1 = s.y * 0.42f;
            var l2 = s.y * 0.38f;
            _shoulder = TwinVisuals.Pivot("Shoulder", _turret, new Vector3(0, 0.3f, 0));
            TwinVisuals.Prim(PrimitiveType.Cylinder, "ShoulderJoint", _shoulder, Vector3.zero, new Vector3(0.24f, 0.16f, 0.24f), joint, Quaternion.Euler(90, 0, 0));
            TwinVisuals.Box("UpperArm", _shoulder, new Vector3(0, l1 / 2, 0), new Vector3(0.16f, l1, 0.18f), arm);

            _elbow = TwinVisuals.Pivot("Elbow", _shoulder, new Vector3(0, l1, 0));
            TwinVisuals.Prim(PrimitiveType.Cylinder, "ElbowJoint", _elbow, Vector3.zero, new Vector3(0.2f, 0.13f, 0.2f), joint, Quaternion.Euler(90, 0, 0));
            TwinVisuals.Box("Forearm", _elbow, new Vector3(0, l2 / 2, 0), new Vector3(0.12f, l2, 0.14f), arm);

            _tool = TwinVisuals.Pivot("Tool", _elbow, new Vector3(0, l2 + 0.08f, 0));
            TwinVisuals.Box("Gripper", _tool, new Vector3(0, -0.04f, 0), new Vector3(0.2f, 0.06f, 0.2f), joint);
            TwinVisuals.Box("FingerA", _tool, new Vector3(0, -0.11f, 0.08f), new Vector3(0.04f, 0.1f, 0.03f), joint);
            TwinVisuals.Box("FingerB", _tool, new Vector3(0, -0.11f, -0.08f), new Vector3(0.04f, 0.1f, 0.03f), joint);

            _shoulderAngle = -20f;
            _elbowAngle = -60f;
            PoseRobot();
            Beacon(new Vector3(-s.x / 2 + 0.08f, 0.3f, -s.z / 2 + 0.08f), 0.9f);
        }

        void BuildBuffer()
        {
            var s = Size;
            var frame = M(TwinVisuals.Frame);
            foreach (var x in new[] { -s.x / 2 + 0.03f, s.x / 2 - 0.03f })
            foreach (var z in new[] { -s.z / 2 + 0.03f, s.z / 2 - 0.03f })
                TwinVisuals.Box("Post", transform, new Vector3(x, s.y / 2, z), new Vector3(0.06f, s.y, 0.06f), frame);
            for (var i = 0; i < ShelfCount; i++)
                TwinVisuals.Box("Shelf", transform, new Vector3(0, ShelfY(i) - 0.025f, 0), new Vector3(s.x, 0.05f, s.z), M(TwinVisuals.Body));
            Beacon(new Vector3(-s.x / 2 + 0.03f, s.y, -s.z / 2 + 0.03f), 0.3f);
        }

        const int ShelfCount = 3;
        float ShelfY(int i) => 0.12f + i * (Size.y - 0.1f) / ShelfCount;

        void BuildInspection()
        {
            var s = Size;
            var bedH = 0.9f;
            TwinVisuals.Box("Bed", transform, new Vector3(0, bedH / 2, 0), new Vector3(s.x * 0.9f, bedH, s.z * 0.45f), M(TwinVisuals.Frame));
            _beltMat = TwinVisuals.NewMaterial(TwinVisuals.Belt, 0.1f);
            TwinVisuals.SetTexture(_beltMat, TwinVisuals.StripeTexture, new Vector2(s.x * 0.9f / 0.25f, 1f));
            TwinVisuals.Box("Belt", transform, new Vector3(0, bedH + 0.01f, 0), new Vector3(s.x * 0.9f, 0.02f, s.z * 0.4f), _beltMat);
            _partTableY = bedH + 0.02f;

            var post = M(TwinVisuals.Body);
            foreach (var z in new[] { -s.z / 2 + 0.06f, s.z / 2 - 0.06f })
                TwinVisuals.Box("Post", transform, new Vector3(0, s.y / 2, z), new Vector3(0.12f, s.y, 0.12f), post);
            TwinVisuals.Box("Beam", transform, new Vector3(0, s.y - 0.06f, 0), new Vector3(0.16f, 0.12f, s.z), post);
            _camHead = TwinVisuals.Pivot("CameraHead", transform, new Vector3(0, s.y - 0.12f, 0));
            TwinVisuals.Box("Camera", _camHead, new Vector3(0, -0.12f, 0), new Vector3(0.2f, 0.22f, 0.2f), M(TwinVisuals.BodyDark));
            TwinVisuals.Cyl("Lens", _camHead, new Vector3(0, -0.3f, 0), 0.1f, 0.07f, M(TwinVisuals.Glass));
            Beacon(new Vector3(0, s.y, s.z / 2 - 0.06f), 0.2f);
        }

        void BuildSource()
        {
            var s = Size;
            var bodyH = s.y * 0.75f;
            TwinVisuals.Box("Hopper", transform, new Vector3(-s.x * 0.1f, bodyH / 2, 0), new Vector3(s.x * 0.8f, bodyH, s.z), M(TwinVisuals.Body));
            TwinVisuals.Box("Lip", transform, new Vector3(-s.x * 0.1f, bodyH + 0.05f, 0), new Vector3(s.x * 0.85f, 0.1f, s.z * 1.05f), M(TwinVisuals.BodyDark));
            TwinVisuals.Box("Chute", transform, new Vector3(s.x * 0.4f, 0.85f, 0), new Vector3(s.x * 0.25f, 0.06f, s.z * 0.45f), M(TwinVisuals.Frame));
            _partTableY = 0.88f;
            Beacon(new Vector3(-s.x / 2 + 0.1f, bodyH + 0.1f, -s.z / 2 + 0.1f), 0.25f);
        }

        void BuildSink()
        {
            var s = Size;
            var wood = M(TwinVisuals.Hex("#8C7A5B"));
            for (var i = 0; i < 5; i++)
                TwinVisuals.Box("Slat", transform, new Vector3(0, 0.12f, Mathf.Lerp(-s.z / 2 + 0.08f, s.z / 2 - 0.08f, i / 4f)), new Vector3(s.x, 0.04f, 0.14f), wood);
            foreach (var z in new[] { -s.z / 2 + 0.08f, 0f, s.z / 2 - 0.08f })
                TwinVisuals.Box("Block", transform, new Vector3(0, 0.05f, z), new Vector3(s.x, 0.1f, 0.12f), wood);
            _stack = TwinVisuals.Box("Stack", transform, new Vector3(0, 0.14f, 0), new Vector3(s.x * 0.85f, 0.001f, s.z * 0.85f), M(TwinVisuals.Hex("#B58B55"))).transform;
            _partTableY = 0.14f;
            Beacon(new Vector3(-s.x / 2, 0, -s.z / 2), Mathf.Max(0.6f, s.y));
        }

        void BuildSelectionFrame()
        {
            _selectionFrame = new GameObject("Selection");
            _selectionFrame.transform.SetParent(transform, false);
            var mat = TwinVisuals.NewMaterial(TwinVisuals.Selection * 0.2f, 0.2f);
            TwinVisuals.SetEmission(mat, TwinVisuals.Selection);
            var m = 0.2f;
            var w = 0.06f;
            var sx = Size.x + 2 * m;
            var sz = Size.z + 2 * m;
            var t = _selectionFrame.transform;
            TwinVisuals.Box("N", t, new Vector3(0, 0.01f, sz / 2), new Vector3(sx + w, 0.02f, w), mat);
            TwinVisuals.Box("S", t, new Vector3(0, 0.01f, -sz / 2), new Vector3(sx + w, 0.02f, w), mat);
            TwinVisuals.Box("E", t, new Vector3(sx / 2, 0.01f, 0), new Vector3(w, 0.02f, sz), mat);
            TwinVisuals.Box("W", t, new Vector3(-sx / 2, 0.01f, 0), new Vector3(w, 0.02f, sz), mat);
            _selectionFrame.SetActive(false);
        }

        void BuildLabel()
        {
            var go = new GameObject("Label");
            go.transform.SetParent(transform, false);
            go.transform.localPosition = new Vector3(0, Size.y + 0.75f, 0);
            var tm = go.AddComponent<TextMesh>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (font != null)
            {
                tm.font = font;
                go.GetComponent<MeshRenderer>().sharedMaterial = font.material;
            }
            tm.text = Def.Id;
            tm.fontSize = 48;
            tm.characterSize = 0.085f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.color = new Color(0.95f, 0.95f, 0.95f);
            _label = go.transform;
        }

        // ================================================================= robot targets

        /// <summary>Aim the robot's pick and place poses at world points (usually the upstream and downstream assets).</summary>
        public void SetPickPlace(Vector3? pickWorld, Vector3? placeWorld)
        {
            if (pickWorld.HasValue) _pickYaw = YawTo(pickWorld.Value);
            if (placeWorld.HasValue) _placeYaw = YawTo(placeWorld.Value);
            _yaw = (_pickYaw + Mathf.DeltaAngle(_pickYaw, _placeYaw) * 0.5f);
            PoseRobot();
        }

        float YawTo(Vector3 world)
        {
            var d = transform.InverseTransformPoint(world);
            return Mathf.Atan2(-d.z, d.x) * Mathf.Rad2Deg;
        }

        void PoseRobot()
        {
            if (_turret == null) return;
            _turret.localRotation = Quaternion.Euler(0, _yaw, 0);
            // Arm is built pointing up (+Y); negative Z rotation leans it towards local +X.
            _shoulder.localRotation = Quaternion.Euler(0, 0, _shoulderAngle);
            _elbow.localRotation = Quaternion.Euler(0, 0, _elbowAngle);
            // Keep the gripper level, hanging straight down, whatever the arm angles are.
            _tool.rotation = Quaternion.Euler(0, _turret.eulerAngles.y, 0);
        }

        // ================================================================= state

        public void ApplyState(AssetState s)
        {
            if (s == null) return;
            if (State == null || State.State != s.State) _sinceStateChange = 0f;
            State = s;
            UpdateBeacon(0f);
        }

        public void SetSelected(bool on)
        {
            Selected = on;
            if (_selectionFrame != null) _selectionFrame.SetActive(on);
        }

        void UpdateBeacon(float t)
        {
            if (_beaconMat == null || State == null) return;
            var kind = State.State;
            var c = TwinVisuals.StateColor(kind);
            // Lit lamps: dark base + emission of the exact token colour, so the light does not wash it out.
            var lit = 0f;
            switch (kind)
            {
                case AssetStateKind.Running:
                case AssetStateKind.Maintenance:
                case AssetStateKind.Starved:
                    lit = 1f;
                    break;
                case AssetStateKind.Blocked:
                    // "Hatched" in 2D; here a slow pulse distinguishes it from Starved.
                    lit = Mathf.Lerp(0.35f, 1f, 0.5f + 0.5f * Mathf.Sin(t * Mathf.PI * 2f * 0.7f));
                    break;
                case AssetStateKind.Fault:
                    lit = Mathf.Repeat(t, 0.5f) < 0.25f ? 1.2f : 0f; // 2 Hz blink
                    break;
            }
            var emission = c * lit;
            if (lit > 0f) c *= 0.2f;
            else if (kind == AssetStateKind.Fault) c *= 0.45f;
            TwinVisuals.SetColor(_beaconMat, c);
            TwinVisuals.SetEmission(_beaconMat, emission);
        }

        // ================================================================= animation

        void Update()
        {
            if (Def == null) return;
            var dt = Time.deltaTime;
            _sinceStateChange += dt;
            UpdateBeacon(Time.time);

            var running = State != null && State.State == AssetStateKind.Running;
            var target = State != null ? (float)State.CycleProgress : 0f;
            // Progress arrives at ~5 Hz: ease towards it, but snap on wrap-around (new cycle).
            _displayProgress = target < _displayProgress - 0.5f ? target : Mathf.MoveTowards(_displayProgress, target, dt * 2f);

            if (_spindle != null && running)
                _spindle.Rotate(0f, 1440f * dt, 0f, Space.Self);

            if (_beltMat != null && running)
            {
                var speed = (float)Def.Param(ParamKeys.SpeedMps, 0.25);
                _beltOffset -= speed * dt / 0.25f;
                TwinVisuals.SetTextureOffset(_beltMat, new Vector2(_beltOffset, 0f));
            }

            if (_camHead != null && running)
                _camHead.localPosition = new Vector3(0, _camHead.localPosition.y, Mathf.Sin(Time.time * 3f) * Size.z * 0.15f);

            if (_turret != null) AnimateRobot(running, dt);

            if (_stack != null && State != null)
            {
                var layers = Mathf.Clamp((int)(State.Good % 40), 0, 40);
                var h = Mathf.Max(0.001f, layers * 0.03f);
                _stack.localScale = new Vector3(_stack.localScale.x, h, _stack.localScale.z);
                _stack.localPosition = new Vector3(0, 0.14f + h / 2, 0);
            }
        }

        void AnimateRobot(bool running, float dt)
        {
            float yaw, shoulder, elbow;
            if (running)
            {
                // 0-.15 pick (down), .15-.5 swing to place (up), .5-.65 place (down), .65-1 swing back.
                var p = _displayProgress;
                float swing, down;
                if (p < 0.15f) { swing = 0f; down = 1f; }
                else if (p < 0.5f) { swing = Mathf.SmoothStep(0f, 1f, (p - 0.15f) / 0.35f); down = 0f; }
                else if (p < 0.65f) { swing = 1f; down = 1f; }
                else { swing = 1f - Mathf.SmoothStep(0f, 1f, (p - 0.65f) / 0.35f); down = 0f; }
                yaw = _pickYaw + Mathf.DeltaAngle(_pickYaw, _placeYaw) * swing;
                shoulder = Mathf.Lerp(-25f, -55f, down);
                elbow = Mathf.Lerp(-55f, -75f, down);
            }
            else
            {
                yaw = _pickYaw + Mathf.DeltaAngle(_pickYaw, _placeYaw) * 0.5f;
                shoulder = -15f;
                elbow = -70f;
            }
            var k = 1f - Mathf.Exp(-dt * 8f);
            _yaw = Mathf.LerpAngle(_yaw, yaw, k);
            _shoulderAngle = Mathf.Lerp(_shoulderAngle, shoulder, k);
            _elbowAngle = Mathf.Lerp(_elbowAngle, elbow, k);
            PoseRobot();
        }

        void LateUpdate()
        {
            var cam = Camera.main;
            if (_label != null && cam != null)
                _label.rotation = Quaternion.LookRotation(_label.position - cam.transform.position, cam.transform.up);
        }

        // ================================================================= parts

        /// <summary>World position for a part inside this asset at progress 0..1.</summary>
        public Vector3 PartWorldPosition(double progress, int indexInAsset)
        {
            var p = Mathf.Clamp01((float)progress);
            var s = Size;
            var half = PartSize / 2f;
            Vector3 local;
            switch (Def.Kind)
            {
                case AssetKind.Conveyor:
                    local = new Vector3(Mathf.Lerp(-s.x / 2 + 0.2f, s.x / 2 - 0.2f, p), s.y + half, 0);
                    break;
                case AssetKind.Buffer:
                {
                    var cap = Mathf.Max(1, (int)Def.Param(ParamKeys.Capacity, 10));
                    var slot = Mathf.Clamp(Mathf.FloorToInt(p * cap), 0, cap - 1);
                    if (p <= 0f) slot = Mathf.Clamp(indexInAsset, 0, cap - 1);
                    var perShelf = Mathf.CeilToInt(cap / (float)ShelfCount);
                    var shelf = Mathf.Min(ShelfCount - 1, slot / perShelf);
                    var col = slot % perShelf;
                    var x = perShelf == 1 ? 0f : Mathf.Lerp(-s.x / 2 + 0.2f, s.x / 2 - 0.2f, col / (float)(perShelf - 1));
                    local = new Vector3(x, ShelfY(shelf) + half, 0);
                    break;
                }
                case AssetKind.Robot:
                    if (_tool != null) return _tool.position + Vector3.down * (half + 0.08f);
                    local = new Vector3(0, s.y, 0);
                    break;
                case AssetKind.Machine:
                    local = new Vector3(Mathf.Lerp(-0.15f, 0.15f, p) * s.x, _partTableY + half, -s.z * 0.05f);
                    break;
                case AssetKind.Inspection:
                    local = new Vector3(Mathf.Lerp(-s.x * 0.4f, s.x * 0.4f, p), _partTableY + half, 0);
                    break;
                case AssetKind.Source:
                    local = new Vector3(s.x * 0.4f, _partTableY + half, 0);
                    break;
                case AssetKind.Sink:
                    local = new Vector3(Mathf.Lerp(-s.x * 0.3f, s.x * 0.3f, p), (_stack != null ? _stack.localPosition.y + _stack.localScale.y / 2 : _partTableY) + half, 0);
                    break;
                default:
                    local = new Vector3(0, s.y + half, 0);
                    break;
            }
            return transform.TransformPoint(local);
        }

        void OnDestroy()
        {
            TwinVisuals.DestroySafe(_beaconMat);
            TwinVisuals.DestroySafe(_beltMat);
        }
    }
}
