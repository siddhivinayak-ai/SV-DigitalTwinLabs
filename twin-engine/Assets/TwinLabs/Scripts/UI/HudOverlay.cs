using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;

namespace TwinLabs.Unity
{
    /// <summary>
    /// Dense IMGUI overlay in the classic engineering style of docs/V1-Spec.md §4
    /// (control grey chrome, navy pane titles, Tahoma 11 / Consolas numerics, ISA-101 status colours).
    /// Toolbar: connection, Start/Pause/Stop/Reset, speed. KPI strip. Properties pane for the
    /// selected asset (state, wear, sensors, KPIs, fault/maintenance/enable). Events/alarms pane. Status bar.
    /// Also handles click-to-select in the 3D view.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class HudOverlay : MonoBehaviour
    {
        public TwinConnection connection;
        public PlantBuilder plant;
        public OrbitCamera orbit;

        [Tooltip("UI scale multiplier (1 = 96 dpi look). 0 = auto from screen DPI.")]
        public float uiScale = 0f;

        public bool showProperties = true;
        public bool showLog = true;

        /// <summary>True while the mouse is over any HUD pane (camera and picking ignore input).</summary>
        public static bool PointerOverHud { get; private set; }

        /// <summary>True while a HUD text field has keyboard focus.</summary>
        public static bool KeyboardCaptured { get; private set; }

        static readonly double[] Speeds = { 0.25, 1, 2, 5, 10, 50, 100 };
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        const float ToolbarH = 28f, KpiH = 22f, StatusH = 20f, RowH = 18f, PropW = 300f, LogH = 168f, LogW = 520f;

        readonly List<Rect> _rects = new List<Rect>();
        string _urlEdit;
        Vector2 _propScroll, _logScroll;
        int _logTab;
        Vector2 _clickStart;
        bool _clickArmed;
        float _fps, _fpsAccum;
        int _fpsFrames;
        float _scale = 1f;

        // ---- styles
        bool _stylesReady;
        GUIStyle _bar, _panel, _title, _label, _labelBold, _num, _numBold, _button, _buttonOn, _field, _small, _row, _rowAlt, _status;
        readonly Dictionary<Color, Texture2D> _swatches = new Dictionary<Color, Texture2D>();
        readonly List<Texture2D> _owned = new List<Texture2D>();

        static readonly Color Chrome = TwinVisuals.Hex("#D4D0C8");
        static readonly Color PanelBg = TwinVisuals.Hex("#ECE9D8");
        static readonly Color WindowBg = TwinVisuals.Hex("#F5F4EE");
        static readonly Color Shadow = TwinVisuals.Hex("#808080");
        static readonly Color Dark = TwinVisuals.Hex("#404040");
        static readonly Color Navy0 = TwinVisuals.Hex("#0A246A");
        static readonly Color Navy1 = TwinVisuals.Hex("#3A6EA5");
        static readonly Color Ink = TwinVisuals.Hex("#000000");

        void Awake()
        {
            if (connection == null) connection = FindAnyObjectByType<TwinConnection>();
            if (plant == null) plant = FindAnyObjectByType<PlantBuilder>();
            if (orbit == null) orbit = FindAnyObjectByType<OrbitCamera>();
            _urlEdit = connection != null ? connection.serverUrl : "http://localhost:5080";
        }

        void OnDestroy()
        {
            foreach (var t in _owned) TwinVisuals.DestroySafe(t);
            _owned.Clear();
            PointerOverHud = false;
            KeyboardCaptured = false;
        }

        // ================================================================= picking + hover

        void Update()
        {
            _fpsAccum += Time.unscaledDeltaTime;
            _fpsFrames++;
            if (_fpsAccum >= 0.5f) { _fps = _fpsFrames / _fpsAccum; _fpsAccum = 0; _fpsFrames = 0; }

            var m = TwinInput.MousePosition;
            var gui = new Vector2(m.x, Screen.height - m.y) / Mathf.Max(0.01f, _scale);
            var over = false;
            foreach (var r in _rects) if (r.Contains(gui)) { over = true; break; }
            PointerOverHud = over;

            if (TwinInput.Down(TwinInput.Left))
            {
                _clickArmed = !over && !TwinInput.Shift;
                _clickStart = m;
            }
            if (TwinInput.Up(TwinInput.Left) && _clickArmed)
            {
                _clickArmed = false;
                if ((m - _clickStart).sqrMagnitude < 25f && plant != null)
                    plant.Select(plant.Pick(Camera.main, m));
            }
            if (TwinInput.KeyDown(KeyCode.Escape) && !KeyboardCaptured && plant != null) plant.Select((AssetView)null);
        }

        // ================================================================= GUI

        void OnGUI()
        {
            EnsureStyles();
            _scale = uiScale > 0f ? uiScale : Mathf.Clamp((Screen.dpi > 0 ? Screen.dpi : 96f) / 96f, 1f, 2.5f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(_scale, _scale, 1f));
            var w = Screen.width / _scale;
            var h = Screen.height / _scale;

            if (Event.current.type == EventType.Layout) _rects.Clear();

            DrawToolbar(new Rect(0, 0, w, ToolbarH));
            DrawKpiStrip(new Rect(0, ToolbarH, w, KpiH));
            DrawStatusBar(new Rect(0, h - StatusH, w, StatusH));

            var top = ToolbarH + KpiH + 6f;
            var bottom = h - StatusH - 6f;
            if (showProperties && plant != null && plant.SelectedView != null)
                DrawProperties(new Rect(w - PropW - 6f, top, PropW, Mathf.Min(560f, bottom - top)));
            if (showLog)
                DrawLog(new Rect(6f, bottom - LogH, Mathf.Min(LogW, w - 12f), LogH));

            KeyboardCaptured = GUIUtility.keyboardControl != 0;
        }

        void Track(Rect r)
        {
            if (Event.current.type == EventType.Layout || Event.current.type == EventType.Repaint)
                if (!_rects.Contains(r)) _rects.Add(r);
        }

        // ---- toolbar

        void DrawToolbar(Rect r)
        {
            Track(r);
            GUI.Box(r, GUIContent.none, _bar);
            GUILayout.BeginArea(new Rect(r.x + 4, r.y + 3, r.width - 8, r.height - 6));
            GUILayout.BeginHorizontal();

            var state = connection != null ? connection.State : ConnectionState.Disconnected;
            Led(ConnectionColor(state), 12);
            GUILayout.Label(state.ToString().ToUpperInvariant(), _labelBold, GUILayout.Width(98));

            GUI.SetNextControlName("url");
            _urlEdit = GUILayout.TextField(_urlEdit ?? "", _field, GUILayout.Width(170));
            if (GUILayout.Button(state == ConnectionState.Connected || state == ConnectionState.Connecting ? "Reconnect" : "Connect", _button, GUILayout.Width(70)) && connection != null)
            {
                connection.serverUrl = _urlEdit;
                connection.Connect();
                GUIUtility.keyboardControl = 0;
            }
            if (state != ConnectionState.Disconnected && state != ConnectionState.Offline && GUILayout.Button("Disconnect", _button, GUILayout.Width(74)) && connection != null)
                connection.Disconnect();
            if (state != ConnectionState.Connected && ExampleAvailable && GUILayout.Button("Load Example", _button, GUILayout.Width(88)) && connection != null)
                connection.LoadExample();

            Sep();
            var connected = state == ConnectionState.Connected;
            var run = connection?.Sim?.State ?? SimRunState.Stopped;
            GUI.enabled = connected;
            if (GUILayout.Button("▶ Start", run == SimRunState.Running ? _buttonOn : _button, GUILayout.Width(58))) Cmd(CommandActions.SimStart);
            if (GUILayout.Button("|| Pause", run == SimRunState.Paused ? _buttonOn : _button, GUILayout.Width(58))) Cmd(CommandActions.SimPause);
            if (GUILayout.Button("■ Stop", run == SimRunState.Stopped ? _buttonOn : _button, GUILayout.Width(52))) Cmd(CommandActions.SimStop);
            if (GUILayout.Button("Reset", _button, GUILayout.Width(48))) Cmd(CommandActions.SimReset);

            Sep();
            GUILayout.Label("Speed", _label, GUILayout.Width(36));
            var speed = connection?.Sim?.Speed ?? 1;
            foreach (var s in Speeds)
            {
                var on = Math.Abs(speed - s) < 1e-6;
                if (GUILayout.Button(SpeedLabel(s), on ? _buttonOn : _button, GUILayout.Width(s < 1 ? 42 : 36)))
                    connection?.SendCommand(CommandActions.SimSpeed, value: s);
            }
            GUI.enabled = true;

            GUILayout.FlexibleSpace();
            GUILayout.Label(plant?.Plant != null ? plant.Plant.Name : "No plant", _label);
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }

        // ---- KPI strip

        void DrawKpiStrip(Rect r)
        {
            Track(r);
            GUI.Box(r, GUIContent.none, _panel);
            var k = connection?.Kpi?.Line;
            var sim = connection?.Sim;
            GUILayout.BeginArea(new Rect(r.x + 6, r.y + 2, r.width - 12, r.height - 4));
            GUILayout.BeginHorizontal();
            Kv("Sim", sim != null ? Clock(sim.SimTimeMs) : "--:--:--.-", 86);
            Kv("State", sim != null ? sim.State.ToString().ToUpperInvariant() : "-", 64);
            Kv("x", sim != null ? sim.Speed.ToString("0.##", Inv) : "-", 40);
            Sep();
            Kv("OEE", Pct(k?.Oee), 50);
            Kv("A", Pct(k?.Availability), 50);
            Kv("P", Pct(k?.Performance), 50);
            Kv("Q", Pct(k?.Quality), 50);
            Sep();
            Kv("Thru/h", k != null ? k.ThroughputPerHour.ToString("0.0", Inv) : "-", 50);
            Kv("WIP", k != null ? k.Wip.ToString(Inv) : "-", 34);
            Kv("Good", k != null ? k.Good.ToString(Inv) : "-", 48);
            Kv("Scrap", k != null ? k.Scrap.ToString(Inv) : "-", 40);
            Kv("Bottleneck", k?.BottleneckAssetId ?? "-", 70);
            GUILayout.FlexibleSpace();
            var alarms = connection != null ? connection.Alarms.Count : 0;
            if (alarms > 0)
            {
                Led(TwinVisuals.Fault, 10, blink: true);
                GUILayout.Label(alarms + " active alarm" + (alarms == 1 ? "" : "s"), _labelBold);
            }
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }

        // ---- properties

        void DrawProperties(Rect r)
        {
            Track(r);
            var view = plant.SelectedView;
            var def = view.Def;
            connection.Assets.TryGetValue(def.Id, out var st);
            st = st ?? view.State;

            GUI.Box(r, GUIContent.none, _panel);
            TitleBar(new Rect(r.x, r.y, r.width, 18), "Properties - " + def.Id, () => plant.Select((AssetView)null));

            GUILayout.BeginArea(new Rect(r.x + 4, r.y + 20, r.width - 8, r.height - 24));
            _propScroll = GUILayout.BeginScrollView(_propScroll, false, false);

            Section("Asset");
            Row("Name", def.Name);
            Row("Kind", def.Kind.ToString());
            Row("Position", $"{def.Position?.X:0.##}, {def.Position?.Y:0.##}, {def.Position?.Z:0.##}");

            Section("State");
            GUILayout.BeginHorizontal(_row);
            GUILayout.Label("State", _label, GUILayout.Width(110));
            var stateKind = st?.State ?? AssetStateKind.Idle;
            Led(TwinVisuals.StateColor(stateKind), 10, stateKind == AssetStateKind.Fault);
            GUILayout.Label(TwinVisuals.StateLabel(stateKind), _labelBold);
            GUILayout.EndHorizontal();
            if (st != null)
            {
                var since = connection.Sim != null ? Math.Max(0, connection.Sim.SimTimeMs - st.StateSinceMs) : 0;
                RowNum("In state", (since / 1000.0).ToString("0.0", Inv) + " s");
                RowBar("Load", st.Load, TwinVisuals.Running);
                RowBar("Wear", st.Wear, st.Wear > 0.7 ? TwinVisuals.Fault : st.Wear > 0.4 ? TwinVisuals.Amber : TwinVisuals.Hex("#5A7FA8"));
                RowBar("Cycle", st.CycleProgress, TwinVisuals.Hex("#5A7FA8"));
                RowNum("WIP", st.Wip.ToString(Inv));
                RowNum("Good", st.Good.ToString(Inv));
                RowNum("Scrap", st.Scrap.ToString(Inv));
            }

            Section("Sensors");
            var any = false;
            foreach (var sd in connection.SensorDefs.Values)
            {
                if (sd.AssetId != def.Id) continue;
                any = true;
                var has = connection.Sensors.TryGetValue(sd.Id, out var v);
                var c = Ink;
                if (has && sd.HiHi.HasValue && v >= sd.HiHi.Value) c = TwinVisuals.Fault;
                else if (has && sd.Hi.HasValue && v >= sd.Hi.Value) c = TwinVisuals.Hex("#B07800");
                var suffix = sd.Id.StartsWith(def.Id + ".", StringComparison.Ordinal) ? sd.Id.Substring(def.Id.Length + 1) : sd.Id;
                var lim = sd.Hi.HasValue ? $"  H{sd.Hi.Value:0.#}" + (sd.HiHi.HasValue ? $"/HH{sd.HiHi.Value:0.#}" : "") : "";
                GUILayout.BeginHorizontal(_row);
                GUILayout.Label(suffix + lim, _label, GUILayout.Width(150));
                var old = _num.normal.textColor;
                _num.normal.textColor = c;
                GUILayout.Label(has ? v.ToString("0.00", Inv) : "--", _num, GUILayout.Width(60));
                _num.normal.textColor = old;
                GUILayout.Label(sd.Unit ?? "", _small);
                GUILayout.EndHorizontal();
            }
            if (!any) Row("", "(no sensors)");

            var ak = FindAssetKpi(def.Id);
            if (ak != null)
            {
                Section("KPI");
                RowNum("OEE", Pct(ak.Oee));
                RowNum("Availability", Pct(ak.Availability));
                RowNum("Performance", Pct(ak.Performance));
                RowNum("Quality", Pct(ak.Quality));
                RowNum("Utilization", Pct(ak.Utilization));
            }

            if (def.Params != null && def.Params.Count > 0)
            {
                Section("Parameters");
                foreach (var kv in def.Params) RowNum(kv.Key, kv.Value.ToString("0.###", Inv));
            }

            Section("Commands");
            GUI.enabled = connection.State == ConnectionState.Connected;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Inject Fault", _button)) connection.SendCommand(CommandActions.AssetFault, def.Id);
            if (GUILayout.Button("Clear Fault", _button)) connection.SendCommand(CommandActions.AssetClearFault, def.Id);
            GUILayout.EndHorizontal();
            GUILayout.BeginHorizontal();
            var inMaint = stateKind == AssetStateKind.Maintenance;
            if (GUILayout.Button(inMaint ? "End Maintenance" : "Maintenance", inMaint ? _buttonOn : _button))
                connection.SendCommand(CommandActions.AssetMaintenance, def.Id, inMaint ? 0 : 1);
            var off = stateKind == AssetStateKind.Off;
            if (GUILayout.Button(off ? "Enable" : "Disable", off ? _buttonOn : _button))
                connection.SendCommand(CommandActions.AssetEnable, def.Id, off ? 1 : 0);
            GUILayout.EndHorizontal();
            GUI.enabled = true;
            if (orbit != null && GUILayout.Button("Focus (F)", _button)) orbit.Focus(view);

            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        AssetKpi FindAssetKpi(string id)
        {
            var list = connection?.Kpi?.Assets;
            if (list == null) return null;
            foreach (var a in list) if (a != null && a.AssetId == id) return a;
            return null;
        }

        // ---- log

        void DrawLog(Rect r)
        {
            Track(r);
            GUI.Box(r, GUIContent.none, _panel);
            TitleBar(new Rect(r.x, r.y, r.width, 18), "Event Log", null);
            var tabs = new Rect(r.x + 4, r.y + 20, r.width - 8, 20);
            GUILayout.BeginArea(tabs);
            GUILayout.BeginHorizontal();
            var alarms = connection != null ? connection.Alarms.Count : 0;
            if (GUILayout.Button("Events", _logTab == 0 ? _buttonOn : _button, GUILayout.Width(70))) _logTab = 0;
            if (GUILayout.Button("Alarms (" + alarms + ")", _logTab == 1 ? _buttonOn : _button, GUILayout.Width(90))) _logTab = 1;
            GUILayout.EndHorizontal();
            GUILayout.EndArea();

            GUILayout.BeginArea(new Rect(r.x + 4, r.y + 42, r.width - 8, r.height - 46));
            _logScroll = GUILayout.BeginScrollView(_logScroll, false, true);
            if (connection != null)
            {
                var i = 0;
                if (_logTab == 0)
                {
                    for (var e = connection.Events.Count - 1; e >= 0; e--)
                    {
                        var ev = connection.Events[e];
                        GUILayout.BeginHorizontal(i++ % 2 == 0 ? _row : _rowAlt);
                        Led(SeverityColor(ev.Severity), 8);
                        GUILayout.Label(Clock(ev.TimeMs), _num, GUILayout.Width(80));
                        GUILayout.Label(ev.AssetId ?? "", _labelBold, GUILayout.Width(62));
                        GUILayout.Label(ev.Message ?? "", _label);
                        GUILayout.EndHorizontal();
                    }
                    if (connection.Events.Count == 0) GUILayout.Label("(no events)", _small);
                }
                else
                {
                    foreach (var a in connection.Alarms.Values)
                    {
                        GUILayout.BeginHorizontal(i++ % 2 == 0 ? _row : _rowAlt);
                        Led(SeverityColor(a.Severity), 8, !a.Acknowledged);
                        GUILayout.Label(Clock(a.RaisedAtMs), _num, GUILayout.Width(80));
                        if (GUILayout.Button(a.AssetId ?? "", _labelBold, GUILayout.Width(62)) && plant != null) plant.Select(a.AssetId);
                        GUILayout.Label(a.Message ?? "", _label);
                        GUI.enabled = !a.Acknowledged && connection.State == ConnectionState.Connected;
                        if (GUILayout.Button(a.Acknowledged ? "ACK'd" : "Ack", _button, GUILayout.Width(44)))
                            connection.SendCommand(CommandActions.AlarmAck, alarmId: a.Id);
                        GUI.enabled = true;
                        GUILayout.EndHorizontal();
                    }
                    if (connection.Alarms.Count == 0) GUILayout.Label("(no active alarms)", _small);
                }
            }
            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        // ---- status bar

        void DrawStatusBar(Rect r)
        {
            Track(r);
            GUI.Box(r, GUIContent.none, _status);
            GUILayout.BeginArea(new Rect(r.x + 4, r.y + 1, r.width - 8, r.height - 2));
            GUILayout.BeginHorizontal();
            var state = connection != null ? connection.State : ConnectionState.Disconnected;
            Led(ConnectionColor(state), 10);
            GUILayout.Label(state.ToString().ToUpperInvariant(), _labelBold, GUILayout.Width(96));
            StatusSep();
            GUILayout.Label("Sim " + (connection?.Sim != null ? Clock(connection.Sim.SimTimeMs) : "--"), _num, GUILayout.Width(110));
            StatusSep();
            GUILayout.Label("x" + (connection?.Sim?.Speed ?? 1).ToString("0.##", Inv), _num, GUILayout.Width(50));
            StatusSep();
            GUILayout.Label((connection?.Sim?.State ?? SimRunState.Stopped).ToString().ToUpperInvariant(), _label, GUILayout.Width(66));
            StatusSep();
            GUILayout.Label(_fps.ToString("0", Inv) + " fps", _num, GUILayout.Width(56));
            StatusSep();
            GUILayout.Label("seq " + (connection?.LastSeq ?? 0), _num, GUILayout.Width(90));
            if (connection != null && connection.SeqGaps > 0)
            {
                StatusSep();
                GUILayout.Label("gaps " + connection.SeqGaps, _num, GUILayout.Width(70));
            }
            StatusSep();
            GUILayout.Label(connection != null ? connection.WebSocketUrl : "", _small);
            if (!string.IsNullOrEmpty(connection?.LastError))
            {
                StatusSep();
                GUILayout.Label(connection.LastError, _small);
            }
            GUILayout.FlexibleSpace();
            GUILayout.Label("LMB orbit | MMB/Shift+LMB pan | wheel zoom | click select | F focus | H frame", _small);
            GUILayout.EndHorizontal();
            GUILayout.EndArea();
        }

        // ================================================================= widgets

        void Cmd(string action) => connection?.SendCommand(action);

        void TitleBar(Rect r, string text, Action onClose)
        {
            GUI.Box(r, GUIContent.none, _title);
            GUI.Label(new Rect(r.x + 4, r.y, r.width - 24, r.height), text, _title);
            if (onClose != null && GUI.Button(new Rect(r.xMax - 17, r.y + 2, 15, 14), "x", _button)) onClose();
        }

        void Section(string text)
        {
            GUILayout.Space(4);
            GUILayout.Label(text, _labelBold);
            var r = GUILayoutUtility.GetRect(1, 1, GUILayout.ExpandWidth(true));
            if (Event.current.type == EventType.Repaint) GUI.DrawTexture(r, Swatch(Shadow));
        }

        void Row(string key, string value)
        {
            GUILayout.BeginHorizontal(_row);
            GUILayout.Label(key, _label, GUILayout.Width(110));
            GUILayout.Label(value ?? "", _label);
            GUILayout.EndHorizontal();
        }

        void RowNum(string key, string value)
        {
            GUILayout.BeginHorizontal(_row);
            GUILayout.Label(key, _label, GUILayout.Width(110));
            GUILayout.Label(value ?? "", _num, GUILayout.Width(80));
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();
        }

        void RowBar(string key, double v01, Color c)
        {
            GUILayout.BeginHorizontal(_row);
            GUILayout.Label(key, _label, GUILayout.Width(110));
            GUILayout.Label(v01.ToString("0.000", Inv), _num, GUILayout.Width(50));
            var r = GUILayoutUtility.GetRect(80, 10, GUILayout.ExpandWidth(true), GUILayout.Height(10));
            if (Event.current.type == EventType.Repaint)
            {
                r.y += 4;
                GUI.DrawTexture(r, Swatch(Color.white));
                GUI.DrawTexture(new Rect(r.x, r.y, r.width * Mathf.Clamp01((float)v01), r.height), Swatch(c));
                DrawFrame(r, Shadow);
            }
            GUILayout.EndHorizontal();
        }

        void Kv(string key, string value, float valueWidth)
        {
            GUILayout.Label(key, _label);
            GUILayout.Label(value, _numBold, GUILayout.Width(valueWidth));
        }

        void Sep()
        {
            GUILayout.Space(4);
            var r = GUILayoutUtility.GetRect(2, 18, GUILayout.Width(2));
            if (Event.current.type == EventType.Repaint)
            {
                GUI.DrawTexture(new Rect(r.x, r.y, 1, r.height), Swatch(Shadow));
                GUI.DrawTexture(new Rect(r.x + 1, r.y, 1, r.height), Swatch(Color.white));
            }
            GUILayout.Space(4);
        }

        void StatusSep()
        {
            var r = GUILayoutUtility.GetRect(1, 16, GUILayout.Width(1));
            if (Event.current.type == EventType.Repaint) GUI.DrawTexture(r, Swatch(Shadow));
            GUILayout.Space(4);
        }

        void Led(Color c, float size, bool blink = false)
        {
            var r = GUILayoutUtility.GetRect(size + 4, RowH, GUILayout.Width(size + 4));
            if (Event.current.type != EventType.Repaint) return;
            if (blink && Mathf.Repeat(Time.unscaledTime, 0.5f) > 0.25f) c = Color.Lerp(c, Chrome, 0.7f);
            var led = new Rect(r.x + 1, r.y + (r.height - size) / 2, size, size);
            GUI.DrawTexture(led, Swatch(c));
            DrawFrame(led, Dark);
        }

        void DrawFrame(Rect r, Color c)
        {
            var t = Swatch(c);
            GUI.DrawTexture(new Rect(r.x, r.y, r.width, 1), t);
            GUI.DrawTexture(new Rect(r.x, r.yMax - 1, r.width, 1), t);
            GUI.DrawTexture(new Rect(r.x, r.y, 1, r.height), t);
            GUI.DrawTexture(new Rect(r.xMax - 1, r.y, 1, r.height), t);
        }

        // ================================================================= helpers

        static bool? _exampleAvailable;
        static bool ExampleAvailable
        {
            get
            {
                if (!_exampleAvailable.HasValue)
                {
                    try { _exampleAvailable = File.Exists(Path.Combine(TwinConnection.ContractsFolder, "plant", "sample_line.json")); }
                    catch { _exampleAvailable = false; }
                }
                return _exampleAvailable.Value;
            }
        }

        static Color ConnectionColor(ConnectionState s)
        {
            switch (s)
            {
                case ConnectionState.Connected: return TwinVisuals.Running;
                case ConnectionState.Connecting: return TwinVisuals.Amber;
                case ConnectionState.Offline: return TwinVisuals.Maintenance;
                default: return TwinVisuals.Fault;
            }
        }

        static Color SeverityColor(Severity s)
        {
            switch (s)
            {
                case Severity.Critical: return TwinVisuals.Fault;
                case Severity.Warning: return TwinVisuals.Amber;
                default: return TwinVisuals.IdleOff;
            }
        }

        static string SpeedLabel(double s) => s < 1 ? s.ToString("0.##", Inv) + "x" : s.ToString("0", Inv) + "x";

        static string Pct(double? v) => v.HasValue ? (v.Value * 100).ToString("0.0", Inv) + "%" : "-";

        public static string Clock(long ms)
        {
            if (ms < 0) ms = 0;
            var t = TimeSpan.FromMilliseconds(ms);
            return $"{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00}.{t.Milliseconds / 100}";
        }

        Texture2D Swatch(Color c)
        {
            if (_swatches.TryGetValue(c, out var t) && t != null) return t;
            t = Solid(c);
            _swatches[c] = t;
            return t;
        }

        Texture2D Solid(Color c)
        {
            var t = new Texture2D(1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
            t.SetPixel(0, 0, c);
            t.Apply();
            _owned.Add(t);
            return t;
        }

        /// <summary>4x4 bevel for 9-slicing: light top/left, dark bottom/right (inverted when sunken).</summary>
        Texture2D Bevel(Color face, Color hi, Color lo)
        {
            var t = new Texture2D(4, 4, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, filterMode = FilterMode.Point };
            for (var y = 0; y < 4; y++)
            for (var x = 0; x < 4; x++)
            {
                // Texture y=0 is the bottom row.
                Color c = face;
                if (y == 0 || x == 3) c = lo;
                else if (y == 3 || x == 0) c = hi;
                t.SetPixel(x, y, c);
            }
            t.Apply();
            _owned.Add(t);
            return t;
        }

        Texture2D Gradient(Color a, Color b)
        {
            var t = new Texture2D(16, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, wrapMode = TextureWrapMode.Clamp };
            for (var x = 0; x < 16; x++) t.SetPixel(x, 0, Color.Lerp(a, b, x / 15f));
            t.Apply();
            _owned.Add(t);
            return t;
        }

        void EnsureStyles()
        {
            if (_stylesReady) return;
            _stylesReady = true;

            Font ui = null, mono = null;
            try
            {
                ui = Font.CreateDynamicFontFromOSFont(new[] { "Tahoma", "Segoe UI", "Arial" }, 11);
                mono = Font.CreateDynamicFontFromOSFont(new[] { "Consolas", "Courier New" }, 11);
            }
            catch { /* fall back to the default IMGUI font */ }


            GUIStyle Text(Font f, FontStyle fs, TextAnchor a, Color c)
            {
                var s = new GUIStyle(GUI.skin.label) { font = f, fontSize = 11, fontStyle = fs, alignment = a, wordWrap = false, clipping = TextClipping.Clip, padding = new RectOffset(2, 2, 1, 1), margin = new RectOffset(1, 1, 0, 0), fixedHeight = RowH, richText = false };
                s.normal.textColor = c;
                s.hover.textColor = c;
                return s;
            }

            _label = Text(ui, FontStyle.Normal, TextAnchor.MiddleLeft, Ink);
            _labelBold = Text(ui, FontStyle.Bold, TextAnchor.MiddleLeft, Ink);
            _small = Text(ui, FontStyle.Normal, TextAnchor.MiddleLeft, Dark);
            _num = Text(mono, FontStyle.Normal, TextAnchor.MiddleRight, Ink);
            _numBold = Text(mono, FontStyle.Bold, TextAnchor.MiddleRight, Ink);

            _bar = new GUIStyle { border = new RectOffset(1, 1, 1, 1) };
            _bar.normal.background = Bevel(Chrome, Color.white, Shadow);
            _panel = new GUIStyle { border = new RectOffset(1, 1, 1, 1) };
            _panel.normal.background = Bevel(PanelBg, Color.white, Dark);
            _status = new GUIStyle { border = new RectOffset(1, 1, 1, 1) };
            _status.normal.background = Bevel(Chrome, Shadow, Color.white);

            _title = new GUIStyle(_labelBold) { padding = new RectOffset(4, 4, 1, 1) };
            _title.normal.background = Gradient(Navy0, Navy1);
            _title.normal.textColor = Color.white;

            _button = new GUIStyle(_label) { alignment = TextAnchor.MiddleCenter, fixedHeight = 22, border = new RectOffset(1, 1, 1, 1), padding = new RectOffset(4, 4, 2, 2), margin = new RectOffset(1, 1, 0, 0) };
            var raised = Bevel(Chrome, Color.white, Dark);
            var sunken = Bevel(TwinVisuals.Hex("#C4C0B8"), Dark, Color.white);
            _button.normal.background = raised;
            _button.hover.background = Bevel(TwinVisuals.Hex("#E0DCD4"), Color.white, Dark);
            _button.active.background = sunken;
            _button.onNormal.background = sunken;
            _button.normal.textColor = _button.hover.textColor = _button.active.textColor = Ink;
            _buttonOn = new GUIStyle(_button);
            _buttonOn.normal.background = sunken;
            _buttonOn.hover.background = sunken;
            _buttonOn.fontStyle = FontStyle.Bold;

            _field = new GUIStyle(GUI.skin.textField) { font = mono, fontSize = 11, fixedHeight = 20, border = new RectOffset(1, 1, 1, 1), padding = new RectOffset(3, 3, 2, 2), margin = new RectOffset(1, 1, 1, 0) };
            var fieldBg = Bevel(Color.white, Shadow, TwinVisuals.Hex("#FFFFFF"));
            _field.normal.background = _field.hover.background = _field.focused.background = _field.onNormal.background = fieldBg;
            _field.normal.textColor = _field.hover.textColor = _field.focused.textColor = Ink;

            _row = new GUIStyle { fixedHeight = RowH, margin = new RectOffset(0, 0, 0, 0) };
            _row.normal.background = Swatch(WindowBg);
            _rowAlt = new GUIStyle(_row);
            _rowAlt.normal.background = Swatch(PanelBg);
        }
    }
}
