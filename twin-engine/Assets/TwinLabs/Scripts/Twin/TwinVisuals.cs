using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace TwinLabs.Unity
{
    /// <summary>Colour tokens (docs/V1-Spec.md §4) and procedural geometry helpers. Works with URP or Built-in.</summary>
    public static class TwinVisuals
    {
        // ---- ISA-101 status colours
        public static readonly Color Running = Hex("#76B900");
        public static readonly Color IdleOff = Hex("#A0A0A0");
        public static readonly Color Amber = Hex("#E8A317");
        public static readonly Color Fault = Hex("#D0021B");
        public static readonly Color Maintenance = Hex("#4A90D9");
        public static readonly Color Selection = Hex("#0F62FE");

        // ---- neutral equipment greys (normal = grey per ISA-101)
        public static readonly Color Body = Hex("#B9B7B0");
        public static readonly Color BodyDark = Hex("#6E6E6A");
        public static readonly Color Frame = Hex("#4A4B4F");
        public static readonly Color Belt = Hex("#2A2B2E");
        public static readonly Color Glass = new Color(0.18f, 0.22f, 0.26f, 1f);
        public static readonly Color Floor = Hex("#5A5B5E");
        public static readonly Color PartColor = Hex("#D8DCE0");

        public static Color Hex(string hex)
        {
            return ColorUtility.TryParseHtmlString(hex, out var c) ? c : Color.magenta;
        }

        public static Color StateColor(AssetStateKind s)
        {
            switch (s)
            {
                case AssetStateKind.Running: return Running;
                case AssetStateKind.Starved:
                case AssetStateKind.Blocked: return Amber;
                case AssetStateKind.Fault: return Fault;
                case AssetStateKind.Maintenance: return Maintenance;
                default: return IdleOff;
            }
        }

        public static string StateLabel(AssetStateKind s) => s.ToString().ToUpperInvariant();

        // ---- materials

        static readonly Dictionary<Color, Material> SharedCache = new Dictionary<Color, Material>();
        static Material _template;

        static Material Template
        {
            get
            {
                if (_template != null) return _template;
                var rp = GraphicsSettings.currentRenderPipeline;
                if (rp != null && rp.defaultMaterial != null)
                {
                    _template = new Material(rp.defaultMaterial);
                }
                else
                {
                    var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard") ?? Shader.Find("Diffuse");
                    _template = new Material(shader);
                }
                _template.name = "TwinLabs Template";
                _template.hideFlags = HideFlags.DontSave;
                return _template;
            }
        }

        /// <summary>A material shared by every object using this colour (do not mutate).</summary>
        public static Material Shared(Color c, float smoothness = 0.25f, float metallic = 0f)
        {
            if (SharedCache.TryGetValue(c, out var m) && m != null) return m;
            m = NewMaterial(c, smoothness, metallic);
            SharedCache[c] = m;
            return m;
        }

        /// <summary>A material owned by the caller (safe to mutate, e.g. beacons, belts).</summary>
        public static Material NewMaterial(Color c, float smoothness = 0.25f, float metallic = 0f)
        {
            var m = new Material(Template) { hideFlags = HideFlags.DontSave, name = "TwinLabs " + ColorUtility.ToHtmlStringRGB(c) };
            SetColor(m, c);
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", smoothness);
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", smoothness);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", metallic);
            return m;
        }

        public static void SetColor(Material m, Color c)
        {
            if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
            if (m.HasProperty("_Color")) m.SetColor("_Color", c);
        }

        public static void SetEmission(Material m, Color c)
        {
            if (!m.HasProperty("_EmissionColor")) return;
            if (c.maxColorComponent > 0.001f)
            {
                m.EnableKeyword("_EMISSION");
                m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            }
            else
            {
                m.DisableKeyword("_EMISSION");
            }
            m.SetColor("_EmissionColor", c);
        }

        public static void SetTexture(Material m, Texture t, Vector2 tiling)
        {
            if (m.HasProperty("_BaseMap")) { m.SetTexture("_BaseMap", t); m.SetTextureScale("_BaseMap", tiling); }
            if (m.HasProperty("_MainTex")) { m.SetTexture("_MainTex", t); m.SetTextureScale("_MainTex", tiling); }
        }

        public static void SetTextureOffset(Material m, Vector2 offset)
        {
            if (m.HasProperty("_BaseMap")) m.SetTextureOffset("_BaseMap", offset);
            if (m.HasProperty("_MainTex")) m.SetTextureOffset("_MainTex", offset);
        }

        // ---- textures

        static Texture2D _grid, _stripes;

        /// <summary>1 m floor grid cell: thin light line on two edges.</summary>
        public static Texture2D GridTexture
        {
            get
            {
                if (_grid != null) return _grid;
                const int n = 64;
                _grid = new Texture2D(n, n, TextureFormat.RGBA32, true) { name = "TwinLabs Grid", wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Trilinear, anisoLevel = 8, hideFlags = HideFlags.DontSave };
                var bg = new Color(0.46f, 0.465f, 0.47f);
                var line = new Color(0.56f, 0.565f, 0.57f);
                var px = new Color[n * n];
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                    px[y * n + x] = x < 1 || y < 1 ? line : bg;
                _grid.SetPixels(px);
                _grid.Apply(true);
                return _grid;
            }
        }

        /// <summary>Belt texture with cross stripes, scrolled to show motion.</summary>
        public static Texture2D StripeTexture
        {
            get
            {
                if (_stripes != null) return _stripes;
                const int n = 32;
                _stripes = new Texture2D(n, n, TextureFormat.RGBA32, true) { name = "TwinLabs Belt", wrapMode = TextureWrapMode.Repeat, hideFlags = HideFlags.DontSave };
                var px = new Color[n * n];
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                    px[y * n + x] = x < 4 ? new Color(0.55f, 0.55f, 0.55f) : Color.white;
                _stripes.SetPixels(px);
                _stripes.Apply(true);
                return _stripes;
            }
        }

        // ---- primitives

        /// <summary>Create a primitive without a collider (picking uses one BoxCollider per asset).</summary>
        public static GameObject Prim(PrimitiveType type, string name, Transform parent, Vector3 localPos, Vector3 localScale, Material mat, Quaternion? localRot = null)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            var col = go.GetComponent<Collider>();
            if (col != null) DestroySafe(col);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localRotation = localRot ?? Quaternion.identity;
            go.transform.localScale = localScale;
            var r = go.GetComponent<Renderer>();
            r.sharedMaterial = mat;
            r.shadowCastingMode = ShadowCastingMode.On;
            return go;
        }

        public static GameObject Box(string name, Transform parent, Vector3 center, Vector3 size, Material mat)
            => Prim(PrimitiveType.Cube, name, parent, center, size, mat);

        /// <summary>Vertical cylinder from its bottom-centre with diameter d and height h.</summary>
        public static GameObject Cyl(string name, Transform parent, Vector3 bottom, float d, float h, Material mat)
            => Prim(PrimitiveType.Cylinder, name, parent, bottom + Vector3.up * (h * 0.5f), new Vector3(d, h * 0.5f, d), mat);

        public static Transform Pivot(string name, Transform parent, Vector3 localPos)
        {
            var t = new GameObject(name).transform;
            t.SetParent(parent, false);
            t.localPosition = localPos;
            return t;
        }

        public static void DestroySafe(Object o)
        {
            if (o == null) return;
            if (Application.isPlaying) Object.Destroy(o);
            else Object.DestroyImmediate(o);
        }
    }
}
