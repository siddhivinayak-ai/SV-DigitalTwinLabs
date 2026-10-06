using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace TwinLabs.Unity.Editor
{
    /// <summary>Editor helpers: build TwinScene, preview example data offline.</summary>
    public static class TwinLabsSetup
    {
        public const string ScenePath = "Assets/TwinLabs/Scenes/TwinScene.unity";

        [MenuItem("TwinLabs/Create Twin Scene", priority = 0)]
        public static void CreateSceneMenu()
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            var scene = CreateScene();
            if (scene.IsValid()) Debug.Log("[TwinLabs] Created " + ScenePath);
        }

        /// <summary>Batchmode entry point: Unity.exe -batchmode -projectPath ... -executeMethod TwinLabs.Unity.Editor.TwinLabsSetup.CreateSceneBatch -quit</summary>
        public static void CreateSceneBatch()
        {
            var scene = CreateScene();
            if (!scene.IsValid())
            {
                Debug.LogError("[TwinLabs] Scene creation failed");
                EditorApplication.Exit(1);
                return;
            }
            Debug.Log("[TwinLabs] Batch scene creation OK: " + ScenePath);
        }

        public static Scene CreateScene()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets/TwinLabs/Scenes");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // ---- lighting
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.62f, 0.64f, 0.68f);
            RenderSettings.ambientEquatorColor = new Color(0.45f, 0.46f, 0.48f);
            RenderSettings.ambientGroundColor = new Color(0.25f, 0.25f, 0.26f);
            RenderSettings.skybox = null;
            RenderSettings.fog = false;

            var sun = new GameObject("Directional Light");
            var light = sun.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.15f;
            light.color = new Color(1f, 0.97f, 0.92f);
            light.shadows = LightShadows.Soft;
            light.shadowStrength = 0.6f;
            sun.transform.rotation = Quaternion.Euler(52f, -35f, 0f);

            var fill = new GameObject("Fill Light");
            var fillLight = fill.AddComponent<Light>();
            fillLight.type = LightType.Directional;
            fillLight.intensity = 0.25f;
            fillLight.shadows = LightShadows.None;
            fill.transform.rotation = Quaternion.Euler(35f, 150f, 0f);

            // ---- twin runtime
            var twin = new GameObject("TwinLabs");
            var connection = twin.AddComponent<TwinConnection>();
            var builder = twin.AddComponent<PlantBuilder>();
            var parts = twin.AddComponent<PartsView>();
            var hud = twin.AddComponent<HudOverlay>();
            builder.connection = connection;
            parts.connection = connection;
            parts.plant = builder;

            // ---- camera
            var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
            var cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = TwinVisuals.Hex("#2B2D31");
            cam.fieldOfView = 45f;
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 600f;
            camGo.AddComponent<AudioListener>();
            var orbit = camGo.AddComponent<OrbitCamera>();
            orbit.plant = builder;
            // Default framing for Line A (x 0..41 m).
            orbit.pivot = new Vector3(20.5f, 0.5f, 0f);
            orbit.distance = 30f;
            orbit.pitch = 32f;
            orbit.yaw = -20f;
            var rot = Quaternion.Euler(orbit.pitch, orbit.yaw, 0f);
            camGo.transform.SetPositionAndRotation(orbit.pivot - rot * Vector3.forward * orbit.distance, rot);

            hud.connection = connection;
            hud.plant = builder;
            hud.orbit = orbit;

            foreach (var c in new Object[] { connection, builder, parts, hud, orbit }) EditorUtility.SetDirty(c);

            if (!EditorSceneManager.SaveScene(scene, ScenePath)) return default;
            AddToBuildSettings(ScenePath);
            AssetDatabase.SaveAssets();
            return scene;
        }

        static void AddToBuildSettings(string path)
        {
            var scenes = EditorBuildSettings.scenes.Where(s => s.path != path).ToList();
            scenes.Insert(0, new EditorBuildSettingsScene(path, true));
            EditorBuildSettings.scenes = scenes.ToArray();
        }

        // ================================================================= offline example

        [MenuItem("TwinLabs/Load Example Snapshot", priority = 20)]
        public static void LoadExample()
        {
            var connection = Object.FindAnyObjectByType<TwinConnection>();
            if (connection == null)
            {
                EditorUtility.DisplayDialog("TwinLabs", "No TwinConnection in the open scene. Run TwinLabs > Create Twin Scene first.", "OK");
                return;
            }

            if (Application.isPlaying)
            {
                connection.LoadExample();
                return;
            }

            // Edit mode: build a non-saved preview of contracts/plant/sample_line.json + examples/tick.json.
            var builder = Object.FindAnyObjectByType<PlantBuilder>();
            if (builder == null) return;
            var root = TwinConnection.ContractsFolder;
            var plant = TwinJson.Deserialize<PlantModel>(File.ReadAllText(Path.Combine(root, "plant", "sample_line.json")));
            builder.Build(plant);
            var tickPath = Path.Combine(root, "examples", "tick.json");
            if (File.Exists(tickPath))
            {
                var tick = TwinJson.Data<TickData>(TwinJson.ParseEnvelope(File.ReadAllText(tickPath)));
                if (tick?.Assets != null)
                    foreach (var s in tick.Assets)
                        if (builder.Views.TryGetValue(s.Id, out var v)) v.ApplyState(s);
            }
            SceneView.RepaintAll();
            Debug.Log("[TwinLabs] Edit-mode preview built from " + root + " (not saved with the scene). Use TwinLabs > Clear Preview to remove it.");
        }

        [MenuItem("TwinLabs/Clear Preview", priority = 21)]
        public static void ClearPreview()
        {
            var builder = Object.FindAnyObjectByType<PlantBuilder>();
            if (builder != null && !Application.isPlaying) builder.Clear();
            SceneView.RepaintAll();
        }

        [MenuItem("TwinLabs/Open Twin Scene", priority = 1)]
        public static void OpenScene()
        {
            if (!File.Exists(ScenePath))
            {
                CreateSceneMenu();
                return;
            }
            if (EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
                EditorSceneManager.OpenScene(ScenePath);
        }
    }
}
