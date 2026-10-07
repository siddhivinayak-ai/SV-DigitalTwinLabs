using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace TwinLabs.Unity.Editor
{
    /// <summary>
    /// Offline checks against the shared contract files:
    /// every contracts/examples/*.json envelope and contracts/plant/sample_line.json must parse into the Unity DTOs
    /// and re-serialise to the same JSON (camelCase, string enums, nulls omitted). Optionally renders a preview PNG.
    /// Batchmode: -executeMethod TwinLabs.Unity.Editor.TwinLabsSelfTest.RunBatch [-twinShot C:\path\shot.png]
    /// </summary>
    public static class TwinLabsSelfTest
    {
        [MenuItem("TwinLabs/Run Contract Self-Test", priority = 40)]
        public static void RunMenu()
        {
            var failures = Run();
            EditorUtility.DisplayDialog("TwinLabs", failures == 0 ? "All contract examples round-trip OK." : failures + " failure(s); see Console.", "OK");
        }

        public static void RunBatch()
        {
            var failures = Run();
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, "-twinShot");
            if (i >= 0 && i + 1 < args.Length) RenderPreview(args[i + 1]);
            EditorApplication.Exit(failures == 0 ? 0 : 1);
        }

        public static int Run()
        {
            var root = TwinConnection.ContractsFolder;
            var failures = 0;

            var plantPath = Path.Combine(root, "plant", "sample_line.json");
            failures += Check(plantPath, json =>
            {
                var plant = TwinJson.Deserialize<PlantModel>(json);
                if (plant.Assets.Count != 11) throw new Exception("expected 11 assets, got " + plant.Assets.Count);
                return JToken.FromObject(plant, TwinJson.Serializer);
            });

            foreach (var file in Directory.GetFiles(Path.Combine(root, "examples"), "*.json").OrderBy(f => f))
            {
                failures += Check(file, json =>
                {
                    var name = Path.GetFileName(file);
                    var obj = JObject.Parse(json);
                    if (obj["type"] == null)
                    {
                        // REST bodies (history, whatif): not consumed by the Unity client.
                        return null;
                    }
                    var env = TwinJson.ParseEnvelope(json);
                    object data;
                    switch (env.Type)
                    {
                        case MessageTypes.Snapshot: data = TwinJson.Data<SnapshotData>(env); break;
                        case MessageTypes.Tick: data = TwinJson.Data<TickData>(env); break;
                        case MessageTypes.Kpi: data = TwinJson.Data<KpiReport>(env); break;
                        case MessageTypes.Event: data = TwinJson.Data<EventRecord>(env); break;
                        case MessageTypes.Alarm: data = TwinJson.Data<Alarm>(env); break;
                        case MessageTypes.Params: data = TwinJson.Data<ParamsData>(env); break;
                        case MessageTypes.Ack: data = TwinJson.Data<AckData>(env); break;
                        case MessageTypes.Command: data = TwinJson.Data<CommandData>(env); break;
                        default: Debug.Log("[TwinLabs] skip " + name + " (type " + env.Type + ")"); return null;
                    }
                    return JObject.Parse(TwinJson.SerializeEnvelope(env.Type, env.T, env.Seq, data));
                });
            }

            Debug.Log(failures == 0 ? "[TwinLabs] Self-test PASSED" : "[TwinLabs] Self-test FAILED: " + failures);
            return failures;
        }

        static int Check(string path, Func<string, JToken> roundTrip)
        {
            var name = Path.GetFileName(path);
            try
            {
                var json = File.ReadAllText(path);
                var back = roundTrip(json);
                if (back == null) { Debug.Log("[TwinLabs] skip " + name + " (REST body)"); return 0; }
                var original = JToken.Parse(json);
                if (!JToken.DeepEquals(Normalise(original), Normalise(back)))
                {
                    Debug.LogError("[TwinLabs] round-trip mismatch in " + name + "\nexpected: " + Normalise(original).ToString(Newtonsoft.Json.Formatting.None) + "\nactual:   " + Normalise(back).ToString(Newtonsoft.Json.Formatting.None));
                    return 1;
                }
                Debug.Log("[TwinLabs] OK " + name);
                return 0;
            }
            catch (Exception ex)
            {
                Debug.LogError("[TwinLabs] " + name + ": " + ex);
                return 1;
            }
        }

        /// <summary>Numbers compared as doubles (1 vs 1.0), empty optional arrays/objects treated as absent.</summary>
        static JToken Normalise(JToken t)
        {
            switch (t.Type)
            {
                case JTokenType.Object:
                    var o = new JObject();
                    foreach (var p in ((JObject)t).Properties().OrderBy(p => p.Name, StringComparer.Ordinal))
                        if (p.Value.Type != JTokenType.Null) o[p.Name] = Normalise(p.Value);
                    return o;
                case JTokenType.Array:
                    return new JArray(((JArray)t).Select(Normalise));
                case JTokenType.Integer:
                case JTokenType.Float:
                    return new JValue(Math.Round(t.Value<double>(), 9));
                default:
                    return t.DeepClone();
            }
        }

        /// <summary>Open TwinScene, build the example preview and render the main camera to a PNG (needs a GPU; not -nographics).</summary>
        static void RenderPreview(string pngPath)
        {
            try
            {
                if (!File.Exists(TwinLabsSetup.ScenePath)) TwinLabsSetup.CreateScene();
                EditorSceneManager.OpenScene(TwinLabsSetup.ScenePath);
                TwinLabsSetup.LoadExample();
                var builder = UnityEngine.Object.FindAnyObjectByType<PlantBuilder>();
                var conn = UnityEngine.Object.FindAnyObjectByType<TwinConnection>();
                var tick = TwinJson.Data<TickData>(TwinJson.ParseEnvelope(File.ReadAllText(Path.Combine(TwinConnection.ContractsFolder, "examples", "tick.json"))));

                // Parts as plain cubes at their target positions (PartsView only runs in play mode).
                var counts = new System.Collections.Generic.Dictionary<string, int>();
                foreach (var p in tick.Parts)
                {
                    if (!builder.Views.TryGetValue(p.AssetId, out var v)) continue;
                    counts.TryGetValue(p.AssetId, out var idx);
                    counts[p.AssetId] = idx + 1;
                    var cube = TwinVisuals.Box("Part " + p.Id, builder.Root, Vector3.zero, Vector3.one * AssetView.PartSize, TwinVisuals.Shared(TwinVisuals.PartColor, 0.6f, 0.6f));
                    cube.transform.position = v.PartWorldPosition(p.Progress, idx);
                    cube.hideFlags = HideFlags.DontSave;
                }
                builder.Select("CNC-02");

                var cam = Camera.main;
                var orbit = cam.GetComponent<OrbitCamera>();
                var rot = Quaternion.Euler(orbit.pitch, orbit.yaw, 0f);
                cam.transform.SetPositionAndRotation(orbit.pivot - rot * Vector3.forward * orbit.distance, rot);

                // Compile shader variants synchronously, otherwise the editor renders the cyan placeholder.
                ShaderUtil.allowAsyncCompilation = false;
                var rt = new RenderTexture(1600, 900, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB) { antiAliasing = 4 };
                cam.targetTexture = rt;
                cam.Render();
                cam.Render(); // second pass: variants requested by the first are ready now
                RenderTexture.active = rt;
                var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
                tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
                tex.Apply();
                File.WriteAllBytes(pngPath, tex.EncodeToPNG());
                cam.targetTexture = null;
                RenderTexture.active = null;
                Debug.Log("[TwinLabs] Preview rendered to " + pngPath + " (conn " + (conn != null) + ")");
            }
            catch (Exception ex)
            {
                Debug.LogError("[TwinLabs] Preview render failed: " + ex);
            }
        }
    }
}
