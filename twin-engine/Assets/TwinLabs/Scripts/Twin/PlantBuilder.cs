using System;
using System.Collections.Generic;
using UnityEngine;

namespace TwinLabs.Unity
{
    /// <summary>
    /// Builds the 3D plant at runtime from the <see cref="PlantModel"/> in each snapshot.
    /// No prefabs: every asset is a procedural primitive composition (<see cref="AssetView"/>).
    /// Contract to Unity: position (x, y, z) -> (x, y, -z), rotationY -> -rotationY.
    /// Also owns the current selection.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class PlantBuilder : MonoBehaviour
    {
        public TwinConnection connection;

        [Tooltip("Margin of floor around the plant footprint (m).")]
        public float floorMargin = 6f;

        public Transform Root { get; private set; }
        public PlantModel Plant { get; private set; }
        public Bounds PlantBounds { get; private set; }
        public readonly Dictionary<string, AssetView> Views = new Dictionary<string, AssetView>();

        public AssetView SelectedView { get; private set; }
        public string SelectedId => SelectedView != null ? SelectedView.Def.Id : null;

        /// <summary>Raised after the scene was (re)built.</summary>
        public event Action<PlantBuilder> OnBuilt;
        public event Action<AssetView> OnSelectionChanged;

        string _builtKey;

        void Awake()
        {
            if (connection == null) connection = FindAnyObjectByType<TwinConnection>();
        }

        void OnEnable()
        {
            if (connection == null) return;
            connection.OnSnapshot += HandleSnapshot;
            connection.OnTick += HandleTick;
            connection.OnParams += HandleParams;
        }

        void OnDisable()
        {
            if (connection == null) return;
            connection.OnSnapshot -= HandleSnapshot;
            connection.OnTick -= HandleTick;
            connection.OnParams -= HandleParams;
        }

        void HandleSnapshot(SnapshotData s)
        {
            if (s?.Plant != null)
            {
                // A snapshot also arrives after sim.reset: rebuild only if the plant changed.
                var key = PlantKey(s.Plant);
                if (key != _builtKey || Root == null) Build(s.Plant);
            }
            ApplyStates(s?.Assets);
        }

        void HandleTick(TickData t) => ApplyStates(t?.Assets);

        void HandleParams(ParamsData p)
        {
            // Params are merged into the AssetDef by TwinConnection; geometry depends only on size.
        }

        static string PlantKey(PlantModel p)
        {
            var key = p.Id + "/" + p.Version + "/" + (p.Assets?.Count ?? 0);
            if (p.Assets != null)
                foreach (var a in p.Assets)
                    key += "|" + a.Id + ":" + a.Kind + ":" + a.Position?.X + "," + a.Position?.Y + "," + a.Position?.Z + ":" + a.RotationY + ":" + a.Size?.X + "," + a.Size?.Y + "," + a.Size?.Z;
            return key;
        }

        void ApplyStates(List<AssetState> states)
        {
            if (states == null) return;
            foreach (var s in states)
                if (s?.Id != null && Views.TryGetValue(s.Id, out var v)) v.ApplyState(s);
        }

        // ================================================================= build

        public void Clear()
        {
            var previous = SelectedId;
            Views.Clear();
            SelectedView = null;
            if (Root != null) TwinVisuals.DestroySafe(Root.gameObject);
            Root = null;
            // Also remove orphaned roots (e.g. an edit-mode preview left over from before a domain reload).
            for (var i = transform.childCount - 1; i >= 0; i--)
            {
                var c = transform.GetChild(i);
                if (c.name.StartsWith("Plant ", StringComparison.Ordinal)) TwinVisuals.DestroySafe(c.gameObject);
            }
            _builtKey = null;
            if (previous != null) OnSelectionChanged?.Invoke(null);
        }

        public void Build(PlantModel plant)
        {
            var previousSelection = SelectedId;
            Clear();
            Plant = plant;
            _builtKey = PlantKey(plant);

            Root = new GameObject("Plant " + plant.Id).transform;
            Root.SetParent(transform, false);

            var bounds = new Bounds();
            var first = true;
            foreach (var def in plant.Assets)
            {
                if (def == null || def.Id == null) continue;
                var go = new GameObject(def.Id);
                go.transform.SetParent(Root, false);
                go.transform.localPosition = TwinJson.ToUnity(def.Position);
                go.transform.localRotation = Quaternion.Euler(0, TwinJson.RotationYToUnity(def.RotationY), 0);
                var view = go.AddComponent<AssetView>();
                view.Build(def);
                Views[def.Id] = view;

                var b = new Bounds(go.transform.position + Vector3.up * view.Size.y / 2, view.Size);
                if (first) { bounds = b; first = false; }
                else bounds.Encapsulate(b);
            }
            if (first) bounds = new Bounds(Vector3.zero, Vector3.one * 4);
            PlantBounds = bounds;

            WireRobots(plant);
            BuildFloor(bounds);
            BuildFlowLines(plant);

            if (!Application.isPlaying)
                foreach (var t in Root.GetComponentsInChildren<Transform>(true))
                    t.gameObject.hideFlags = HideFlags.DontSave;

            if (previousSelection != null && Views.ContainsKey(previousSelection)) Select(previousSelection);
            OnBuilt?.Invoke(this);
        }

        /// <summary>Robots pick from their upstream asset and place into their first downstream.</summary>
        void WireRobots(PlantModel plant)
        {
            foreach (var def in plant.Assets)
            {
                if (def == null || def.Kind != AssetKind.Robot || !Views.TryGetValue(def.Id, out var robot)) continue;
                Vector3? pick = null, place = null;
                foreach (var other in plant.Assets)
                    if (other?.Downstream != null && other.Downstream.Contains(def.Id) && Views.TryGetValue(other.Id, out var up))
                    { pick = up.transform.position; break; }
                if (def.Downstream != null && def.Downstream.Count > 0 && Views.TryGetValue(def.Downstream[0], out var down))
                    place = down.transform.position;
                robot.SetPickPlace(pick, place);
            }
        }

        void BuildFloor(Bounds b)
        {
            var sizeX = Mathf.Ceil(b.size.x + floorMargin * 2);
            var sizeZ = Mathf.Ceil(b.size.z + floorMargin * 2);
            var center = new Vector3(Mathf.Round(b.center.x), 0, Mathf.Round(b.center.z));
            var mat = TwinVisuals.NewMaterial(Color.white, 0f);
            TwinVisuals.SetTexture(mat, TwinVisuals.GridTexture, new Vector2(sizeX, sizeZ));
            // Offset so grid lines fall on whole metres in world space.
            TwinVisuals.SetTextureOffset(mat, new Vector2(Mathf.Repeat(-(center.x - sizeX / 2), 1f), Mathf.Repeat(-(center.z - sizeZ / 2), 1f)));
            var floor = TwinVisuals.Box("Floor", Root, center + Vector3.down * 0.05f, new Vector3(sizeX, 0.1f, sizeZ), mat);
            floor.GetComponent<Renderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;

            // Yellow safety walkway lines along the line, a classic plant-floor cue.
            var paint = TwinVisuals.Shared(TwinVisuals.Hex("#C8A800"), 0.1f);
            foreach (var z in new[] { b.min.z - 1.2f, b.max.z + 1.2f })
                TwinVisuals.Box("Walkway", Root, new Vector3(b.center.x, 0.003f, z), new Vector3(b.size.x + 2f, 0.006f, 0.08f), paint);
        }

        /// <summary>Thin floor arrows between connected assets so the material flow reads at a glance.</summary>
        void BuildFlowLines(PlantModel plant)
        {
            var mat = TwinVisuals.Shared(TwinVisuals.Hex("#8A8C90"), 0.1f);
            foreach (var def in plant.Assets)
            {
                if (def?.Downstream == null || !Views.TryGetValue(def.Id, out var from)) continue;
                foreach (var dId in def.Downstream)
                {
                    if (!Views.TryGetValue(dId, out var to)) continue;
                    var a = from.transform.position; a.y = 0.004f;
                    var c = to.transform.position; c.y = 0.004f;
                    var d = c - a;
                    if (d.sqrMagnitude < 0.01f) continue;
                    var go = TwinVisuals.Box("Flow " + def.Id + ">" + dId, Root, (a + c) / 2, new Vector3(0.05f, 0.004f, d.magnitude), mat);
                    go.transform.rotation = Quaternion.LookRotation(d.normalized, Vector3.up);
                }
            }
        }

        // ================================================================= selection

        public void Select(string assetId)
        {
            AssetView view = null;
            if (assetId != null) Views.TryGetValue(assetId, out view);
            Select(view);
        }

        public void Select(AssetView view)
        {
            if (view == SelectedView) return;
            if (SelectedView != null) SelectedView.SetSelected(false);
            SelectedView = view;
            if (view != null) view.SetSelected(true);
            OnSelectionChanged?.Invoke(view);
        }

        /// <summary>Pick the asset under a screen point (pixels, bottom-left origin).</summary>
        public AssetView Pick(Camera cam, Vector2 screenPoint)
        {
            if (cam == null) return null;
            var ray = cam.ScreenPointToRay(screenPoint);
            if (Physics.Raycast(ray, out var hit, 500f, ~0, QueryTriggerInteraction.Collide))
                return hit.collider.GetComponentInParent<AssetView>();
            return null;
        }
    }
}
