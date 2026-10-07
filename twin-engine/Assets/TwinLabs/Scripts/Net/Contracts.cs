// Unity mirror of the TwinLabs v1 wire contract.
// Source of truth: contracts/README.md + contracts/examples/*.json
// C# server mirror: server/src/TwinLabs.Core/Contracts/*.cs
//
// Any change to the contract must update all three mirrors (C#, TypeScript, Unity).
// Fields are PascalCase here; TwinJson maps them to camelCase on the wire and
// serialises enums as camelCase strings ("running", "fault", ...).

using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace TwinLabs.Unity
{
    // ------------------------------------------------------------------ enums

    public enum AssetKind { Source, Conveyor, Machine, Buffer, Robot, Inspection, Sink }

    public enum AssetStateKind { Off, Idle, Running, Starved, Blocked, Fault, Maintenance }

    public enum SensorKind { Temperature, Vibration, Power, Current, Speed, Level, Count }

    public enum SimRunState { Stopped, Running, Paused }

    public enum Severity { Info, Warning, Critical }

    public enum EventKind { State, Alarm, Command, Info }

    public enum AlarmSource { Limit, Anomaly, Fault }

    // ------------------------------------------------------------------ constants

    public static class MessageTypes
    {
        public const string Snapshot = "snapshot";
        public const string Tick = "tick";
        public const string Event = "event";
        public const string Alarm = "alarm";
        public const string Kpi = "kpi";
        public const string Params = "params";
        public const string Ack = "ack";
        public const string Command = "command";
    }

    public static class CommandActions
    {
        public const string SimStart = "sim.start";
        public const string SimPause = "sim.pause";
        public const string SimStop = "sim.stop";
        public const string SimReset = "sim.reset";
        /// <summary>Value = speed multiplier (0.25..100).</summary>
        public const string SimSpeed = "sim.speed";
        /// <summary>AssetId + Params.</summary>
        public const string AssetParams = "asset.params";
        /// <summary>AssetId + optional DurationS.</summary>
        public const string AssetFault = "asset.fault";
        public const string AssetClearFault = "asset.clearFault";
        /// <summary>AssetId + Value 1 = enter maintenance, 0 = leave.</summary>
        public const string AssetMaintenance = "asset.maintenance";
        /// <summary>AssetId + Value 1 = enable, 0 = switch off.</summary>
        public const string AssetEnable = "asset.enable";
        public const string AlarmAck = "alarm.ack";
    }

    public static class ParamKeys
    {
        public const string ArrivalIntervalS = "arrivalIntervalS";
        public const string ArrivalStdS = "arrivalStdS";
        public const string LengthM = "lengthM";
        public const string SpeedMps = "speedMps";
        public const string Capacity = "capacity";
        public const string CycleTimeS = "cycleTimeS";
        public const string CycleTimeStdS = "cycleTimeStdS";
        public const string MtbfS = "mtbfS";
        public const string MttrS = "mttrS";
        public const string ScrapRate = "scrapRate";
        public const string RatedKw = "ratedKw";
        public const string IdleKw = "idleKw";
        public const string AmbientC = "ambientC";
        public const string TempRiseC = "tempRiseC";
        public const string VibBaselineMms = "vibBaselineMms";
    }

    // ------------------------------------------------------------------ envelope

    /// <summary>Every WebSocket frame: {"type":"tick","t":12300,"seq":17,"data":{...}}.</summary>
    // Not [Serializable]: Data is a raw JToken, decoded per type.
    public sealed class Envelope
    {
        public string Type;
        /// <summary>Sim time in ms.</summary>
        public long T;
        public long Seq;
        public JToken Data;
    }

    // ------------------------------------------------------------------ plant

    /// <summary>Contract-space vector (metres, right-handed, Y up). Use <see cref="TwinJson.ToUnity"/> for Unity space.</summary>
    [Serializable]
    public sealed class Vec3
    {
        public double X;
        public double Y;
        public double Z;
    }

    [Serializable]
    public sealed class AssetDef
    {
        public string Id;
        public string Name;
        public AssetKind Kind;
        public Vec3 Position;
        public double RotationY;
        public Vec3 Size;
        public List<string> Downstream = new List<string>();
        public Dictionary<string, double> Params = new Dictionary<string, double>();

        public double Param(string key, double fallback = 0)
        {
            return Params != null && Params.TryGetValue(key, out var v) ? v : fallback;
        }
    }

    [Serializable]
    public sealed class SensorDef
    {
        public string Id;
        public string AssetId;
        public SensorKind Kind;
        public string Unit;
        public double Noise;
        public double? Hi;
        public double? HiHi;
    }

    [Serializable]
    public sealed class PlantModel
    {
        public string Id;
        public string Name;
        public int Version;
        public int Seed;
        public List<AssetDef> Assets = new List<AssetDef>();
        public List<SensorDef> Sensors = new List<SensorDef>();
    }

    // ------------------------------------------------------------------ runtime

    [Serializable]
    public sealed class SimStatus
    {
        public SimRunState State;
        public double Speed;
        public long SimTimeMs;
        public long Tick;
        public int Seed;
    }

    [Serializable]
    public sealed class AssetState
    {
        public string Id;
        public AssetStateKind State;
        public long StateSinceMs;
        /// <summary>0..1 utilisation right now.</summary>
        public double Load;
        /// <summary>0..1+ accumulated wear.</summary>
        public double Wear;
        /// <summary>Parts inside the asset.</summary>
        public int Wip;
        public long Good;
        public long Scrap;
        /// <summary>0..1 progress of the current cycle, 0 when not processing.</summary>
        public double CycleProgress;
    }

    /// <summary>Compact sensor sample: {"id":"CNC-01.temp","v":61.2}.</summary>
    [Serializable]
    public sealed class SensorValue
    {
        public string Id;
        public double V;
    }

    /// <summary>A part inside an asset. Progress 0..1 along the asset.</summary>
    [Serializable]
    public sealed class PartPosition
    {
        public long Id;
        public string AssetId;
        public double Progress;
    }

    [Serializable]
    public sealed class StateBreakdown
    {
        public double Off;
        public double Idle;
        public double Running;
        public double Starved;
        public double Blocked;
        public double Fault;
        public double Maintenance;
    }

    [Serializable]
    public sealed class EventRecord
    {
        public long Id;
        public long TimeMs;
        public EventKind Kind;
        public Severity Severity;
        public string Message;
        public string AssetId;
        public AssetStateKind? From;
        public AssetStateKind? To;
    }

    [Serializable]
    public sealed class Alarm
    {
        public string Id;
        public AlarmSource Source;
        public Severity Severity;
        public string AssetId;
        public string Message;
        public long RaisedAtMs;
        public bool Active;
        public bool Acknowledged;
        public string SensorId;
        public double? Value;
        public double? Limit;
        public long? ClearedAtMs;
    }

    [Serializable]
    public sealed class AssetKpi
    {
        public string AssetId;
        public double Oee;
        public double Availability;
        public double Performance;
        public double Quality;
        public double Utilization;
        public long Good;
        public long Scrap;
        public StateBreakdown States;
    }

    [Serializable]
    public sealed class LineKpi
    {
        public double Oee;
        public double Availability;
        public double Performance;
        public double Quality;
        public double ThroughputPerHour;
        public int Wip;
        public long Good;
        public long Scrap;
        public string BottleneckAssetId;
    }

    [Serializable]
    public sealed class KpiReport
    {
        public long SimTimeMs;
        public LineKpi Line;
        public List<AssetKpi> Assets = new List<AssetKpi>();
    }

    // ------------------------------------------------------------------ messages

    [Serializable]
    public sealed class SnapshotData
    {
        public PlantModel Plant;
        public SimStatus Sim;
        public List<AssetState> Assets = new List<AssetState>();
        public List<SensorValue> Sensors = new List<SensorValue>();
        public List<PartPosition> Parts = new List<PartPosition>();
        public KpiReport Kpi;
        public List<Alarm> Alarms = new List<Alarm>();
        public List<EventRecord> Events = new List<EventRecord>();
    }

    [Serializable]
    public sealed class TickData
    {
        public SimStatus Sim;
        public List<AssetState> Assets = new List<AssetState>();
        public List<SensorValue> Sensors = new List<SensorValue>();
        public List<PartPosition> Parts = new List<PartPosition>();
    }

    [Serializable]
    public sealed class ParamsData
    {
        public string AssetId;
        public Dictionary<string, double> Params = new Dictionary<string, double>();
    }

    [Serializable]
    public sealed class CommandData
    {
        public string Id;
        public string Action;
        public string AssetId;
        public double? Value;
        public Dictionary<string, double> Params;
        public string AlarmId;
        public double? DurationS;
    }

    [Serializable]
    public sealed class AckData
    {
        public string CommandId;
        public bool Ok;
        public string Error;
    }

    [Serializable]
    public sealed class HealthData
    {
        public string Status;
        public string Version;
    }

    // ------------------------------------------------------------------ JSON helpers

    /// <summary>Shared Newtonsoft settings: camelCase names, camelCase string enums, nulls omitted.</summary>
    public static class TwinJson
    {
        public static readonly JsonSerializerSettings Settings = CreateSettings();
        public static readonly JsonSerializer Serializer = JsonSerializer.Create(Settings);

        static JsonSerializerSettings CreateSettings()
        {
            var naming = new CamelCaseNamingStrategy { ProcessDictionaryKeys = false };
            var s = new JsonSerializerSettings
            {
                ContractResolver = new DefaultContractResolver { NamingStrategy = naming },
                NullValueHandling = NullValueHandling.Ignore,
                MissingMemberHandling = MissingMemberHandling.Ignore,
                DateParseHandling = DateParseHandling.None,
            };
            s.Converters.Add(new StringEnumConverter(new CamelCaseNamingStrategy()));
            return s;
        }

        public static Envelope ParseEnvelope(string json)
        {
            var obj = JObject.Parse(json);
            return new Envelope
            {
                Type = (string)obj["type"],
                T = obj["t"]?.Value<long>() ?? 0,
                Seq = obj["seq"]?.Value<long>() ?? 0,
                Data = obj["data"],
            };
        }

        public static T Data<T>(Envelope env) where T : class
        {
            return env.Data == null || env.Data.Type == JTokenType.Null ? null : env.Data.ToObject<T>(Serializer);
        }

        public static T Deserialize<T>(string json) => JsonConvert.DeserializeObject<T>(json, Settings);

        public static string Serialize(object value) => JsonConvert.SerializeObject(value, Formatting.None, Settings);

        public static string SerializeEnvelope(string type, long t, long seq, object data)
        {
            var env = new JObject
            {
                ["type"] = type,
                ["t"] = t,
                ["seq"] = seq,
                ["data"] = data == null ? null : JToken.FromObject(data, Serializer),
            };
            return env.ToString(Formatting.None);
        }

        /// <summary>Contract (right-handed, Y up) to Unity (left-handed): negate Z.</summary>
        public static UnityEngine.Vector3 ToUnity(Vec3 v)
        {
            return v == null ? UnityEngine.Vector3.zero : new UnityEngine.Vector3((float)v.X, (float)v.Y, (float)-v.Z);
        }

        /// <summary>Size is an extent, so no sign flip.</summary>
        public static UnityEngine.Vector3 SizeToUnity(Vec3 v)
        {
            return v == null ? UnityEngine.Vector3.one : new UnityEngine.Vector3((float)v.X, (float)v.Y, (float)v.Z);
        }

        /// <summary>Mirroring Z flips handedness, so rotation about Y is negated.</summary>
        public static float RotationYToUnity(double rotationYDeg) => (float)-rotationYDeg;
    }
}
