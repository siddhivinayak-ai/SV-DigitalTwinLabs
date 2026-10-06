using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace TwinLabs.Unity
{
    /// <summary>
    /// Tiny mouse/keyboard shim so the client works with the Input System package
    /// (the URP template default) or the legacy Input Manager.
    /// </summary>
    public static class TwinInput
    {
        public const int Left = 0, Right = 1, Middle = 2;

        /// <summary>Mouse position in screen pixels, bottom-left origin.</summary>
        public static Vector2 MousePosition
        {
            get
            {
#if ENABLE_INPUT_SYSTEM
                var m = Mouse.current;
                return m != null ? m.position.ReadValue() : Vector2.zero;
#else
                return Input.mousePosition;
#endif
            }
        }

        /// <summary>Scroll wheel in "notches" (positive = away from user).</summary>
        public static float Scroll
        {
            get
            {
#if ENABLE_INPUT_SYSTEM
                var m = Mouse.current;
                if (m == null) return 0f;
                var y = m.scroll.ReadValue().y;
                // Windows reports 120 per notch through the Input System; normalise to ~1.
                return Mathf.Abs(y) > 10f ? y / 120f : y;
#else
                return Input.mouseScrollDelta.y;
#endif
            }
        }

        public static bool Held(int button)
        {
#if ENABLE_INPUT_SYSTEM
            var b = Button(button);
            return b != null && b.isPressed;
#else
            return Input.GetMouseButton(button);
#endif
        }

        public static bool Down(int button)
        {
#if ENABLE_INPUT_SYSTEM
            var b = Button(button);
            return b != null && b.wasPressedThisFrame;
#else
            return Input.GetMouseButtonDown(button);
#endif
        }

        public static bool Up(int button)
        {
#if ENABLE_INPUT_SYSTEM
            var b = Button(button);
            return b != null && b.wasReleasedThisFrame;
#else
            return Input.GetMouseButtonUp(button);
#endif
        }

        public static bool Shift
        {
            get
            {
#if ENABLE_INPUT_SYSTEM
                var k = Keyboard.current;
                return k != null && k.shiftKey.isPressed;
#else
                return Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift);
#endif
            }
        }

        public static bool Alt
        {
            get
            {
#if ENABLE_INPUT_SYSTEM
                var k = Keyboard.current;
                return k != null && k.altKey.isPressed;
#else
                return Input.GetKey(KeyCode.LeftAlt) || Input.GetKey(KeyCode.RightAlt);
#endif
            }
        }

        public static bool KeyDown(KeyCode key)
        {
#if ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            if (k == null) return false;
            switch (key)
            {
                case KeyCode.F: return k.fKey.wasPressedThisFrame;
                case KeyCode.H: return k.hKey.wasPressedThisFrame;
                case KeyCode.Home: return k.homeKey.wasPressedThisFrame;
                case KeyCode.Escape: return k.escapeKey.wasPressedThisFrame;
                case KeyCode.Space: return k.spaceKey.wasPressedThisFrame;
                default: return false;
            }
#else
            return Input.GetKeyDown(key);
#endif
        }

#if ENABLE_INPUT_SYSTEM
        static UnityEngine.InputSystem.Controls.ButtonControl Button(int button)
        {
            var m = Mouse.current;
            if (m == null) return null;
            switch (button)
            {
                case Left: return m.leftButton;
                case Right: return m.rightButton;
                default: return m.middleButton;
            }
        }
#endif
    }
}
