using System.Collections.Generic;
using UnityEngine;

namespace TwinLabs.Unity
{
    /// <summary>
    /// Renders parts (PartPosition) as pooled cubes keyed by part id. Each part is placed by
    /// assetId + progress via <see cref="AssetView.PartWorldPosition"/>, and eases towards its
    /// target between ~5 Hz ticks (including hops from one asset to the next).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class PartsView : MonoBehaviour
    {
        public TwinConnection connection;
        public PlantBuilder plant;

        [Tooltip("Higher = snappier tracking of the latest tick.")]
        public float followSharpness = 10f;

        [Tooltip("Parts further than this from their target teleport instead of sliding (m).")]
        public float teleportDistance = 6f;

        sealed class Part
        {
            public long Id;
            public string AssetId;
            public double Progress;
            public int Index;
            public Transform T;
            public bool Fresh;
        }

        readonly Dictionary<long, Part> _live = new Dictionary<long, Part>();
        readonly Stack<Transform> _pool = new Stack<Transform>();
        readonly HashSet<long> _seen = new HashSet<long>();
        readonly List<long> _remove = new List<long>();
        readonly Dictionary<string, int> _perAsset = new Dictionary<string, int>();
        Transform _root;
        Material _mat;

        public int LiveCount => _live.Count;

        void Awake()
        {
            if (connection == null) connection = FindAnyObjectByType<TwinConnection>();
            if (plant == null) plant = FindAnyObjectByType<PlantBuilder>();
            _root = new GameObject("Parts").transform;
            _root.SetParent(transform, false);
        }

        void OnEnable()
        {
            if (connection != null)
            {
                connection.OnSnapshot += HandleSnapshot;
                connection.OnTick += HandleTick;
            }
            if (plant != null) plant.OnBuilt += HandleBuilt;
        }

        void OnDisable()
        {
            if (connection != null)
            {
                connection.OnSnapshot -= HandleSnapshot;
                connection.OnTick -= HandleTick;
            }
            if (plant != null) plant.OnBuilt -= HandleBuilt;
        }

        void HandleBuilt(PlantBuilder _) => ReleaseAll();

        void HandleSnapshot(SnapshotData s)
        {
            ReleaseAll();
            Apply(s?.Parts);
        }

        void HandleTick(TickData t) => Apply(t?.Parts);

        void Apply(List<PartPosition> parts)
        {
            _seen.Clear();
            _perAsset.Clear();
            if (parts != null)
            {
                foreach (var p in parts)
                {
                    if (p == null || p.AssetId == null) continue;
                    _seen.Add(p.Id);
                    _perAsset.TryGetValue(p.AssetId, out var idx);
                    _perAsset[p.AssetId] = idx + 1;

                    if (!_live.TryGetValue(p.Id, out var part))
                    {
                        part = new Part { Id = p.Id, T = Rent(p.Id), Fresh = true };
                        _live[p.Id] = part;
                    }
                    part.AssetId = p.AssetId;
                    part.Progress = p.Progress;
                    part.Index = idx;
                }
            }

            _remove.Clear();
            foreach (var kv in _live)
                if (!_seen.Contains(kv.Key)) _remove.Add(kv.Key);
            foreach (var id in _remove)
            {
                Return(_live[id].T);
                _live.Remove(id);
            }
        }

        void LateUpdate()
        {
            if (plant == null) return;
            var k = 1f - Mathf.Exp(-Time.deltaTime * followSharpness);
            foreach (var part in _live.Values)
            {
                if (!plant.Views.TryGetValue(part.AssetId, out var view))
                {
                    part.T.gameObject.SetActive(false);
                    continue;
                }
                var target = view.PartWorldPosition(part.Progress, part.Index);
                if (!part.T.gameObject.activeSelf) part.T.gameObject.SetActive(true);
                if (part.Fresh || (part.T.position - target).sqrMagnitude > teleportDistance * teleportDistance)
                {
                    part.T.position = target;
                    part.Fresh = false;
                }
                else
                {
                    part.T.position = Vector3.Lerp(part.T.position, target, k);
                }
                part.T.rotation = view.transform.rotation;
            }
        }

        Transform Rent(long id)
        {
            Transform t;
            if (_pool.Count > 0)
            {
                t = _pool.Pop();
                t.gameObject.SetActive(true);
            }
            else
            {
                if (_mat == null) _mat = TwinVisuals.NewMaterial(TwinVisuals.PartColor, 0.6f, 0.6f);
                t = TwinVisuals.Box("Part", _root, Vector3.zero, Vector3.one * AssetView.PartSize, _mat).transform;
            }
            t.name = "Part " + id;
            return t;
        }

        void Return(Transform t)
        {
            t.gameObject.SetActive(false);
            _pool.Push(t);
        }

        void ReleaseAll()
        {
            foreach (var p in _live.Values) Return(p.T);
            _live.Clear();
        }

        void OnDestroy()
        {
            TwinVisuals.DestroySafe(_mat);
        }
    }
}
