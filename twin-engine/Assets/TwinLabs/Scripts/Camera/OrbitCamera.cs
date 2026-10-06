using UnityEngine;

namespace TwinLabs.Unity
{
    /// <summary>
    /// CAD-style orbit camera.
    /// LMB/RMB drag = orbit, MMB drag or Shift+LMB drag = pan, wheel = zoom,
    /// F = focus selected asset, H/Home = frame the whole plant.
    /// Input is ignored while the pointer is over the HUD.
    /// </summary>
    [RequireComponent(typeof(Camera))]
    public sealed class OrbitCamera : MonoBehaviour
    {
        public PlantBuilder plant;

        public Vector3 pivot = new Vector3(20f, 0f, 0f);
        public float distance = 38f;
        [Range(-89f, 89f)] public float pitch = 38f;
        public float yaw = -25f;

        public float orbitSpeed = 0.25f;
        public float panSpeed = 1f;
        public float zoomStep = 0.12f;
        public float minDistance = 1.5f;
        public float maxDistance = 200f;
        public float smoothing = 14f;

        Vector3 _pivot;
        float _distance, _pitch, _yaw;
        Vector2 _lastMouse;
        int _dragButton = -1;
        bool _panDrag;

        void Awake()
        {
            if (plant == null) plant = FindAnyObjectByType<PlantBuilder>();
            SnapToTargets();
        }

        void OnEnable()
        {
            if (plant != null) plant.OnBuilt += HandleBuilt;
        }

        void OnDisable()
        {
            if (plant != null) plant.OnBuilt -= HandleBuilt;
        }

        bool _framedOnce;

        void HandleBuilt(PlantBuilder p)
        {
            if (_framedOnce) return;
            _framedOnce = true;
            FrameAll();
            SnapToTargets();
        }

        void SnapToTargets()
        {
            _pivot = pivot;
            _distance = distance;
            _pitch = pitch;
            _yaw = yaw;
            Apply();
        }

        public void FrameAll()
        {
            if (plant == null) return;
            var b = plant.PlantBounds;
            pivot = new Vector3(b.center.x, 0.5f, b.center.z);
            var cam = GetComponent<Camera>();
            var radius = Mathf.Max(b.extents.x, b.extents.z, 2f);
            var fov = cam != null ? cam.fieldOfView : 60f;
            distance = Mathf.Clamp(radius / Mathf.Tan(fov * 0.5f * Mathf.Deg2Rad) * 0.95f, minDistance, maxDistance);
        }

        public void Focus(AssetView view)
        {
            if (view == null) return;
            pivot = view.transform.position + Vector3.up * view.Size.y * 0.5f;
            distance = Mathf.Clamp(view.Size.magnitude * 2.4f + 2f, minDistance, maxDistance);
        }

        void Update()
        {
            var mouse = TwinInput.MousePosition;
            var overHud = HudOverlay.PointerOverHud;

            if (_dragButton < 0 && !overHud)
            {
                for (var b = 0; b < 3; b++)
                {
                    if (!TwinInput.Down(b)) continue;
                    _dragButton = b;
                    _panDrag = b == TwinInput.Middle || (b == TwinInput.Left && TwinInput.Shift);
                    _lastMouse = mouse;
                    break;
                }
            }

            if (_dragButton >= 0)
            {
                if (!TwinInput.Held(_dragButton))
                {
                    _dragButton = -1;
                }
                else
                {
                    var d = mouse - _lastMouse;
                    _lastMouse = mouse;
                    if (_panDrag) Pan(d);
                    else
                    {
                        yaw += d.x * orbitSpeed;
                        pitch = Mathf.Clamp(pitch - d.y * orbitSpeed, -10f, 89f);
                    }
                }
            }

            if (!overHud)
            {
                var scroll = TwinInput.Scroll;
                if (Mathf.Abs(scroll) > 0.01f)
                    distance = Mathf.Clamp(distance * Mathf.Pow(1f - zoomStep, scroll), minDistance, maxDistance);
            }

            if (!HudOverlay.KeyboardCaptured)
            {
                if (TwinInput.KeyDown(KeyCode.F) && plant != null && plant.SelectedView != null) Focus(plant.SelectedView);
                if (TwinInput.KeyDown(KeyCode.H) || TwinInput.KeyDown(KeyCode.Home)) FrameAll();
            }

            var k = 1f - Mathf.Exp(-Time.unscaledDeltaTime * smoothing);
            _pivot = Vector3.Lerp(_pivot, pivot, k);
            _distance = Mathf.Lerp(_distance, distance, k);
            _pitch = Mathf.Lerp(_pitch, pitch, k);
            _yaw = Mathf.LerpAngle(_yaw, yaw, k);
            Apply();
        }

        void Pan(Vector2 d)
        {
            var cam = GetComponent<Camera>();
            var h = cam != null ? Screen.height : 1000;
            var fov = cam != null ? cam.fieldOfView : 60f;
            var metresPerPixel = 2f * _distance * Mathf.Tan(fov * 0.5f * Mathf.Deg2Rad) / Mathf.Max(1, h);
            var right = transform.right;
            var forward = Vector3.ProjectOnPlane(transform.forward, Vector3.up).normalized;
            // Move on the floor plane so pans never dive into the ground.
            var up = Vector3.ProjectOnPlane(transform.up, Vector3.up).sqrMagnitude > 0.01f ? forward : Vector3.forward;
            pivot -= (right * d.x + up * d.y) * metresPerPixel * panSpeed;
        }

        void Apply()
        {
            var rot = Quaternion.Euler(_pitch, _yaw, 0f);
            transform.position = _pivot - rot * Vector3.forward * _distance;
            transform.rotation = rot;
        }
    }
}
