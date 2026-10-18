# Physical Mac horizontal-pan capture

The remaining lag is reported in the macOS app with a trackpad, especially
with many visible events. Linux WebKitGTK under Xvfb is not a substitute for
WKWebView's Mac rendering path. This capture distinguishes a repainting
calendar body from compositor-only motion or input delivery stalls.

1. Open a **debug/inspectable** North Star app window on the affected Mac and
   a dense week. Do not change events during the capture. In Safari, enable
   **Safari → Settings → Advanced → Show features for web developers** if the
   Develop menu is absent. Select the North Star web view from **Develop →
   [this Mac]**. If it is not listed, the build's WKWebView may not be
   inspectable; do not assume a Safari tab is equivalent to the app.
2. In Web Inspector's **Timelines** tab, start a fresh recording, perform a
   3–5 second physical horizontal trackpad pan without changing the day count,
   stop, and export the recording. Repeat on a sparse week using the same
   display and pan speed. Include the Mac model, macOS version, display scale
   or resolution, and approximate visible event-row counts for both runs.
3. In the **Layers** tab, inspect `.day-cols.pan-strip` during a dense pan.
   Note whether it has its own compositing layer, its bounds/memory, paint
   count before and after the gesture, and compositing reasons. If possible,
   capture the Layers view with paint flashing enabled. In Timelines, compare
   **Layout & Rendering** and **Frames**: does each hitch contain Paint or
   Layout, or mainly Composite/Other?

The exported recording or screenshots may contain calendar titles, URLs, or
page snapshots. Use the app's sandbox/mock data when possible; otherwise
review/redact sensitive details before sharing them.

References: [Apple: inspectable WKWebView](https://developer.apple.com/documentation/safari-developer-tools/enabling-inspecting-content-in-your-apps),
[Safari Develop menu](https://support.apple.com/en-gb/guide/safari/sfri20948/mac),
[WebKit Timelines](https://webkit.org/web-inspector/timelines-tab/),
[WebKit Layers](https://webkit.org/web-inspector/layers-tab/).
