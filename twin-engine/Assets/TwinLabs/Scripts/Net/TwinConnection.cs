using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace TwinLabs.Unity
{
    public enum ConnectionState { Disconnected, Connecting, Connected, Offline }

    /// <summary>
    /// WebSocket client for the TwinLabs server (ws://host:5080/ws).
    /// The socket runs on a background task; received frames go into a thread-safe
    /// queue and are decoded and dispatched on the Unity main thread in Update.
    /// Also keeps a merged view of the latest state (assets, sensors, kpi, alarms, events).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class TwinConnection : MonoBehaviour
    {
        [Tooltip("Server base URL. The WebSocket endpoint is <url>/ws (http -> ws, https -> wss).")]
        public string serverUrl = "http://localhost:5080";

        [Tooltip("Connect automatically when the component starts.")]
        public bool connectOnStart = true;

        [Tooltip("Reconnect backoff: first delay, doubled after each failure up to max (seconds).")]
        public float reconnectMinDelay = 0.5f;
        public float reconnectMaxDelay = 10f;

        [Tooltip("Maximum frames dispatched per Update (keeps a backlog from stalling a frame).")]
        public int maxMessagesPerFrame = 200;

        [Tooltip("How many recent events to keep for the HUD.")]
        public int eventHistory = 50;

        // ---- events (always raised on the main thread)
        public event Action<SnapshotData> OnSnapshot;
        public event Action<TickData> OnTick;
        public event Action<KpiReport> OnKpi;
        public event Action<EventRecord> OnEvent;
        public event Action<Alarm> OnAlarm;
        public event Action<ParamsData> OnParams;
        public event Action<AckData> OnAck;
        public event Action<ConnectionState> OnConnectionChanged;

        // ---- latest merged state
        public ConnectionState State { get; private set; } = ConnectionState.Disconnected;
        public string LastError { get; private set; }
        public PlantModel Plant { get; private set; }
        public SimStatus Sim { get; private set; }
        public KpiReport Kpi { get; private set; }
        public long LastSeq { get; private set; }
        public long SeqGaps { get; private set; }
        public long MessagesReceived { get; private set; }
        public float LastTickRealtime { get; private set; } = -1f;
        public AckData LastAck { get; private set; }

        public readonly Dictionary<string, AssetDef> AssetDefs = new Dictionary<string, AssetDef>();
        public readonly Dictionary<string, AssetState> Assets = new Dictionary<string, AssetState>();
        public readonly Dictionary<string, double> Sensors = new Dictionary<string, double>();
        public readonly Dictionary<string, SensorDef> SensorDefs = new Dictionary<string, SensorDef>();
        public readonly Dictionary<string, Alarm> Alarms = new Dictionary<string, Alarm>();
        public readonly List<EventRecord> Events = new List<EventRecord>();
        public List<PartPosition> Parts { get; private set; } = new List<PartPosition>();

        public string WebSocketUrl
        {
            get
            {
                var u = (serverUrl ?? "").Trim().TrimEnd('/');
                if (u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) u = "wss://" + u.Substring(8);
                else if (u.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) u = "ws://" + u.Substring(7);
                else if (!u.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) && !u.StartsWith("wss://", StringComparison.OrdinalIgnoreCase)) u = "ws://" + u;
                return u.EndsWith("/ws", StringComparison.OrdinalIgnoreCase) ? u : u + "/ws";
            }
        }

        // ---- threading
        readonly ConcurrentQueue<Inbound> _inbox = new ConcurrentQueue<Inbound>();
        readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        CancellationTokenSource _cts;
        Task _loop;
        volatile ClientWebSocket _socket;
        long _sendSeq;
        int _commandCounter;

        struct Inbound
        {
            public string Json;          // a frame, or null for a status change
            public ConnectionState? Status;
            public string Error;
        }

        // ================================================================= lifecycle

        bool _started;

        void Start()
        {
            _started = true;
            if (connectOnStart) Connect();
        }

        void OnDestroy() => Shutdown();

        void OnApplicationQuit() => Shutdown();

        void OnDisable()
        {
            // Leaving play mode (with or without domain reload) disables then destroys us.
            Shutdown();
        }

        void OnEnable()
        {
            // Re-enabled during play: resume.
            if (_started && connectOnStart && _loop == null && State != ConnectionState.Offline)
                Connect();
        }

        /// <summary>(Re)start the connection loop with the current <see cref="serverUrl"/>.</summary>
        public void Connect()
        {
            Shutdown();
            _cts = new CancellationTokenSource();
            var url = WebSocketUrl;
            var token = _cts.Token;
            SetState(ConnectionState.Connecting);
            _loop = Task.Run(() => RunLoop(url, token));
        }

        /// <summary>Stop the connection loop and close the socket.</summary>
        public void Disconnect()
        {
            Shutdown();
            SetState(ConnectionState.Disconnected);
        }

        void Shutdown()
        {
            var cts = _cts;
            _cts = null;
            _loop = null;
            if (cts != null)
            {
                try { cts.Cancel(); } catch (ObjectDisposedException) { }
            }
            var s = _socket;
            _socket = null;
            if (s != null)
            {
                try { s.Abort(); } catch { /* ignored */ }
                try { s.Dispose(); } catch { /* ignored */ }
            }
            // Drop anything the old loop queued so it cannot override the new state.
            while (_inbox.TryDequeue(out _)) { }
        }

        // ================================================================= background loop

        async Task RunLoop(string url, CancellationToken token)
        {
            var delay = Mathf.Max(0.1f, reconnectMinDelay);
            var maxDelay = Mathf.Max(delay, reconnectMaxDelay);
            var buffer = new byte[64 * 1024];

            while (!token.IsCancellationRequested)
            {
                var ws = new ClientWebSocket();
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                _socket = ws;
                try
                {
                    _inbox.Enqueue(new Inbound { Status = ConnectionState.Connecting });
                    using (var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(token))
                    {
                        connectTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                        await ws.ConnectAsync(new Uri(url), connectTimeout.Token).ConfigureAwait(false);
                    }
                    _inbox.Enqueue(new Inbound { Status = ConnectionState.Connected });
                    delay = Mathf.Max(0.1f, reconnectMinDelay);

                    using (var ms = new MemoryStream())
                    {
                        while (!token.IsCancellationRequested && ws.State == WebSocketState.Open)
                        {
                            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                            if (result.MessageType == WebSocketMessageType.Close)
                            {
                                try
                                {
                                    await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false);
                                }
                                catch { /* ignored */ }
                                break;
                            }
                            ms.Write(buffer, 0, result.Count);
                            if (!result.EndOfMessage) continue;
                            if (result.MessageType == WebSocketMessageType.Text)
                            {
                                var json = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                                _inbox.Enqueue(new Inbound { Json = json });
                            }
                            ms.SetLength(0);
                        }
                    }
                    _inbox.Enqueue(new Inbound { Status = ConnectionState.Disconnected, Error = "Connection closed by server" });
                }
                catch (Exception ex)
                {
                    if (token.IsCancellationRequested) break;
                    _inbox.Enqueue(new Inbound { Status = ConnectionState.Disconnected, Error = Describe(ex) });
                }
                finally
                {
                    if (ReferenceEquals(_socket, ws)) _socket = null;
                    try { ws.Dispose(); } catch { /* ignored */ }
                }

                if (token.IsCancellationRequested) break;
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(delay), token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { break; }
                delay = Mathf.Min(maxDelay, delay * 2f);
            }
        }

        static string Describe(Exception ex)
        {
            while (ex.InnerException != null && (ex is AggregateException || ex is WebSocketException)) ex = ex.InnerException;
            if (ex is OperationCanceledException) return "Connect timed out";
            return ex.GetType().Name + ": " + ex.Message;
        }

        // ================================================================= main thread dispatch

        void Update()
        {
            var n = 0;
            while (n++ < maxMessagesPerFrame && _inbox.TryDequeue(out var msg))
            {
                if (msg.Status.HasValue)
                {
                    if (msg.Status.Value == ConnectionState.Connected) LastError = null;
                    if (msg.Error != null) LastError = msg.Error;
                    if (State != ConnectionState.Offline) SetState(msg.Status.Value);
                    continue;
                }
                if (msg.Json != null) HandleFrame(msg.Json);
                else if (msg.Error != null) LastError = msg.Error;
            }
        }

        void SetState(ConnectionState s)
        {
            if (State == s) return;
            State = s;
            if (s == ConnectionState.Connected) { LastSeq = 0; SeqGaps = 0; }
            Raise(OnConnectionChanged, s);
        }

        /// <summary>Decode and dispatch one raw JSON frame. Public so offline/example data can be injected.</summary>
        public void HandleFrame(string json)
        {
            Envelope env;
            try
            {
                env = TwinJson.ParseEnvelope(json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[TwinLabs] Bad frame: " + ex.Message);
                return;
            }

            MessagesReceived++;
            if (LastSeq > 0 && env.Seq > LastSeq + 1) SeqGaps += env.Seq - LastSeq - 1;
            if (env.Seq > 0) LastSeq = env.Seq;

            try
            {
                switch (env.Type)
                {
                    case MessageTypes.Snapshot: ApplySnapshot(TwinJson.Data<SnapshotData>(env)); break;
                    case MessageTypes.Tick: ApplyTick(TwinJson.Data<TickData>(env)); break;
                    case MessageTypes.Kpi: ApplyKpi(TwinJson.Data<KpiReport>(env)); break;
                    case MessageTypes.Event: ApplyEvent(TwinJson.Data<EventRecord>(env)); break;
                    case MessageTypes.Alarm: ApplyAlarm(TwinJson.Data<Alarm>(env)); break;
                    case MessageTypes.Params: ApplyParams(TwinJson.Data<ParamsData>(env)); break;
                    case MessageTypes.Ack:
                        var ack = TwinJson.Data<AckData>(env);
                        LastAck = ack;
                        if (ack != null && !ack.Ok) Debug.LogWarning($"[TwinLabs] Command {ack.CommandId} rejected: {ack.Error}");
                        Raise(OnAck, ack);
                        break;
                    default:
                        // Unknown types are ignored for forward compatibility.
                        break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[TwinLabs] Failed to handle '{env.Type}' frame: {ex.Message}");
            }
        }

        void ApplySnapshot(SnapshotData s)
        {
            if (s == null) return;
            Plant = s.Plant;
            Sim = s.Sim;
            Kpi = s.Kpi;
            AssetDefs.Clear();
            SensorDefs.Clear();
            if (Plant != null)
            {
                foreach (var a in Plant.Assets) if (a?.Id != null) AssetDefs[a.Id] = a;
                foreach (var d in Plant.Sensors) if (d?.Id != null) SensorDefs[d.Id] = d;
            }
            Assets.Clear();
            Sensors.Clear();
            Alarms.Clear();
            Events.Clear();
            MergeAssets(s.Assets);
            MergeSensors(s.Sensors);
            Parts = s.Parts ?? new List<PartPosition>();
            if (s.Alarms != null) foreach (var a in s.Alarms) if (a?.Id != null) Alarms[a.Id] = a;
            if (s.Events != null) foreach (var e in s.Events) AddEvent(e);
            LastTickRealtime = Time.realtimeSinceStartup;
            Raise(OnSnapshot, s);
        }

        void ApplyTick(TickData t)
        {
            if (t == null) return;
            if (t.Sim != null) Sim = t.Sim;
            MergeAssets(t.Assets);
            MergeSensors(t.Sensors);
            Parts = t.Parts ?? new List<PartPosition>();
            LastTickRealtime = Time.realtimeSinceStartup;
            Raise(OnTick, t);
        }

        void ApplyKpi(KpiReport k)
        {
            if (k == null) return;
            Kpi = k;
            Raise(OnKpi, k);
        }

        void ApplyEvent(EventRecord e)
        {
            if (e == null) return;
            AddEvent(e);
            Raise(OnEvent, e);
        }

        void ApplyAlarm(Alarm a)
        {
            if (a == null || a.Id == null) return;
            if (a.Active) Alarms[a.Id] = a;
            else Alarms.Remove(a.Id);
            Raise(OnAlarm, a);
        }

        void ApplyParams(ParamsData p)
        {
            if (p == null || p.AssetId == null) return;
            if (AssetDefs.TryGetValue(p.AssetId, out var def) && p.Params != null)
            {
                if (def.Params == null) def.Params = new Dictionary<string, double>();
                foreach (var kv in p.Params) def.Params[kv.Key] = kv.Value;
            }
            Raise(OnParams, p);
        }

        void MergeAssets(List<AssetState> list)
        {
            if (list == null) return;
            foreach (var a in list) if (a?.Id != null) Assets[a.Id] = a;
        }

        void MergeSensors(List<SensorValue> list)
        {
            if (list == null) return;
            foreach (var v in list) if (v?.Id != null) Sensors[v.Id] = v.V;
        }

        void AddEvent(EventRecord e)
        {
            if (e == null) return;
            Events.Add(e);
            var max = Mathf.Max(1, eventHistory);
            if (Events.Count > max) Events.RemoveRange(0, Events.Count - max);
        }

        void Raise<T>(Action<T> handler, T arg)
        {
            if (handler == null) return;
            foreach (Action<T> h in handler.GetInvocationList())
            {
                try { h(arg); }
                catch (Exception ex) { Debug.LogException(ex, this); }
            }
        }

        // ================================================================= commands

        /// <summary>Send a <c>command</c> frame. Returns the generated command id (or null if not connected).</summary>
        public string SendCommand(string action, string assetId = null, double? value = null,
            Dictionary<string, double> parameters = null, string alarmId = null, double? durationS = null)
        {
            var cmd = new CommandData
            {
                Id = "u-" + Interlocked.Increment(ref _commandCounter).ToString("0000"),
                Action = action,
                AssetId = assetId,
                Value = value,
                Params = parameters,
                AlarmId = alarmId,
                DurationS = durationS,
            };
            return Send(cmd) ? cmd.Id : null;
        }

        public bool Send(CommandData cmd)
        {
            var ws = _socket;
            if (ws == null || ws.State != WebSocketState.Open || State != ConnectionState.Connected)
            {
                Debug.LogWarning($"[TwinLabs] Not connected; command '{cmd.Action}' dropped.");
                return false;
            }
            var json = TwinJson.SerializeEnvelope(MessageTypes.Command, Sim?.SimTimeMs ?? 0, Interlocked.Increment(ref _sendSeq), cmd);
            var bytes = Encoding.UTF8.GetBytes(json);
            var token = _cts?.Token ?? CancellationToken.None;
            Task.Run(async () =>
            {
                await _sendLock.WaitAsync(token).ConfigureAwait(false);
                try
                {
                    if (ws.State == WebSocketState.Open)
                        await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    if (!token.IsCancellationRequested) _inbox.Enqueue(new Inbound { Error = "Send failed: " + Describe(ex) });
                }
                finally { _sendLock.Release(); }
            }, token);
            return true;
        }

        // ================================================================= offline example

        /// <summary>Folder holding the shared contract files (repo root /contracts), resolved from the Unity project.</summary>
        public static string ContractsFolder => Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "contracts"));

        /// <summary>
        /// Preview without a server: builds a snapshot from contracts/plant/sample_line.json and
        /// applies contracts/examples/tick.json, kpi.json, alarm.json and event.json.
        /// Works in the Editor (and in a player shipped next to the contracts folder).
        /// </summary>
        public bool LoadExample()
        {
            try
            {
                var root = ContractsFolder;
                var plantPath = Path.Combine(root, "plant", "sample_line.json");
                var plant = TwinJson.Deserialize<PlantModel>(File.ReadAllText(plantPath));

                Shutdown();
                SetState(ConnectionState.Offline);
                LastError = null;

                var snap = new SnapshotData
                {
                    Plant = plant,
                    Sim = new SimStatus { State = SimRunState.Stopped, Speed = 1, Seed = plant.Seed },
                };
                foreach (var a in plant.Assets)
                    snap.Assets.Add(new AssetState { Id = a.Id, State = AssetStateKind.Idle });
                HandleFrame(TwinJson.SerializeEnvelope(MessageTypes.Snapshot, 0, 0, snap));

                foreach (var name in new[] { "tick.json", "kpi.json", "alarm.json", "event.json" })
                {
                    var p = Path.Combine(root, "examples", name);
                    if (File.Exists(p)) HandleFrame(File.ReadAllText(p));
                }
                LastSeq = 0;
                SeqGaps = 0;
                return true;
            }
            catch (Exception ex)
            {
                LastError = "Example load failed: " + ex.Message;
                Debug.LogWarning("[TwinLabs] " + LastError);
                return false;
            }
        }
    }
}
