"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphChartProps } from "@/components/graph/graph-chart-types";
import { useGraphLayout } from "@/components/graph/use-graph-layout";
import { buildSkyIndex } from "@/components/graph/sky-canvas/sky-index";
import { clearTextCache, drawSky } from "@/components/graph/sky-canvas/draw-sky";
import {
  bakeBackground,
  clearSpriteCaches,
  deviceRatio,
} from "@/components/graph/sky-canvas/sky-sprites";
import {
  TAP_TOLERANCE_PX,
  useSkyGestures,
} from "@/components/graph/sky-canvas/use-sky-gestures";
import { hitTest } from "@/lib/graph/hit-test";
import {
  clampPan,
  computeSunExtents,
  fitWorldRect,
  lerpCamera,
  rectOf,
  screenToWorld,
  zoomToFitSunCentered,
  type Camera,
  type Vec2,
} from "@/lib/graph/sky-camera";
import type { SkyFocusState } from "@/lib/graph/sky-emphasis";
import {
  clusterIdFromNodeId,
  selectionForContact,
  selectionForUser,
} from "@/lib/graph/sky-selection";
import type { GraphNodeData } from "@/lib/graph-layout";
import { markGraphViewportReady } from "@/lib/graph/intro-signal";
import { CAMERA_MS } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The constellation as one canvas.
 *
 * The DOM chart spends roughly ten elements per contact — each with an inline gradient
 * and a two-layer glow — plus a blurred nebula per cluster and 220 twinkling spans, and
 * on a phone a large network exhausts memory before it finishes mounting. This draws the
 * same sky into a single pane-sized backing store: constant memory, whatever the network
 * size, and a per-frame cost bounded by the viewport rather than by the contact count.
 *
 * It is deliberately **static**. There is no ambient rotation and no twinkle — at 3°/min
 * and a 3-second breath on two-pixel dots, neither survives a six-inch screen, and an
 * idle canvas is one the system will not reap for sustained compute on a
 * memory-pressured tab. Frames happen when something changes: a gesture, a camera
 * flight, a new selection.
 */
export function GraphCanvasMobile(props: GraphChartProps) {
  const {
    data,
    search,
    searchHitIds,
    focusCluster,
    zoomToken,
    homeToken,
    peekPersonId,
    peekToken,
    positionOverrides,
    selection,
    hoveredId,
    onSelect,
    onFocusCluster,
    compact,
    company,
  } = props;

  const router = useRouter();
  const prefersReducedMotion = usePrefersReducedMotion();
  const { layout, layoutKey } = useGraphLayout(props);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const backgroundRef = useRef<HTMLCanvasElement | null>(null);
  const paneRef = useRef({ width: 0, height: 0 });
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 0.2 });
  const drawRafRef = useRef(0);
  const tweenRafRef = useRef(0);
  const framedKeyRef = useRef<string | null>(null);
  const readyRef = useRef(false);

  const index = useMemo(
    () => buildSkyIndex(layout, positionOverrides),
    [layout, positionOverrides]
  );
  const indexRef = useRef(index);

  const searchQuery = search.trim().toLowerCase();
  const searchDimActive = Boolean(searchQuery || searchHitIds.size > 0) && searchHitIds.size > 0;

  const focus: SkyFocusState = useMemo(
    () => ({
      hoveredId,
      selectedContactId: selection?.type === "contact" ? selection.id : null,
      searchHitIds,
      searchDimActive,
    }),
    [hoveredId, selection, searchHitIds, searchDimActive]
  );

  /**
   * Which cluster's haze stays lit. Mirrors the DOM chart: an explicit company filter,
   * or whichever cluster the current selection belongs to.
   */
  const focusCompany = useMemo(() => {
    if (company !== "all") return company;
    if (selection?.type === "contact") return selection.data.clusterName ?? null;
    return null;
  }, [company, selection]);

  /**
   * Everything the draw loop reads lives in a ref, so a gesture frame never waits on a
   * React render. Synced in an effect rather than during render — this effect is
   * declared ahead of every effect that draws, so by the time a frame is scheduled the
   * refs already hold the values that scheduled it.
   */
  const frameStateRef = useRef({ focus, focusCluster, focusCompany, company, selection });
  useEffect(() => {
    indexRef.current = index;
    frameStateRef.current = { focus, focusCluster, focusCompany, company, selection };
  }, [index, focus, focusCluster, focusCompany, company, selection]);

  const draw = useCallback(() => {
    const ctx = ctxRef.current;
    const { width, height } = paneRef.current;
    if (!ctx || width < 2 || height < 2) return;

    const state = frameStateRef.current;
    drawSky(ctx, {
      index: indexRef.current,
      camera: cameraRef.current,
      width,
      height,
      focus: state.focus,
      focusCluster: state.focusCluster,
      focusCompany: state.focusCompany,
      companyFilter: state.company,
      sunSelected: state.selection?.type === "user",
      background: backgroundRef.current,
    });

    if (!readyRef.current) {
      readyRef.current = true;
      // The intro bus waits on this. Without it a suppressed intro still leaves the
      // handshake half-armed.
      markGraphViewportReady();
    }
  }, []);

  /**
   * One coalescing invalidator. Between interactions this schedules nothing at all —
   * the canvas sits at zero frames until something actually changes.
   */
  const requestDraw = useCallback(() => {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      draw();
    });
  }, [draw]);

  const cancelTween = useCallback(() => {
    if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    tweenRafRef.current = 0;
  }, []);

  /** Fly the camera, or jump straight there under reduced motion. */
  const flyTo = useCallback(
    (target: Camera, duration: number) => {
      cancelTween();
      const pane = paneRef.current;
      const clamped = clampPan(target, indexRef.current.bounds, pane);
      if (prefersReducedMotion || duration <= 0) {
        cameraRef.current = clamped;
        requestDraw();
        return;
      }
      const from = { ...cameraRef.current };
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / duration);
        cameraRef.current = lerpCamera(from, clamped, t);
        draw();
        tweenRafRef.current = t < 1 ? requestAnimationFrame(step) : 0;
      };
      tweenRafRef.current = requestAnimationFrame(step);
    },
    [cancelTween, draw, prefersReducedMotion, requestDraw]
  );

  /** The default view: sun locked to the centre, whole sky in frame. */
  const goHome = useCallback(
    (animated: boolean) => {
      const pane = paneRef.current;
      if (pane.width < 2) return;
      /**
       * No `liveNodes` pass. `computeSunExtents` takes measured DOM boxes only to refine
       * its estimate, which is why the React Flow path needs a fitter that retries until
       * the nodes have been laid out. The canvas draws exactly the constant half-extents
       * this function assumes, so they *are* the truth and one pass is enough.
       */
      const extents = computeSunExtents(layout.nodes, positionOverrides, []);
      const k = zoomToFitSunCentered(extents.maxAbsX, extents.maxAbsY, pane.width, pane.height);
      flyTo({ x: pane.width / 2, y: pane.height / 2, k }, animated ? CAMERA_MS.move : 0);
    },
    [flyTo, layout.nodes, positionOverrides]
  );

  // --- sizing -------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      // A ResizeObserver can fire before layout has given the parent a size.
      if (width < 2 || height < 2) return;

      const dpr = deviceRatio();
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctxRef.current = ctx;

      const previous = paneRef.current;
      paneRef.current = { width, height };
      backgroundRef.current = bakeBackground(width, height, dpr);

      if (previous.width < 2) {
        // First real size — frame the sky.
        goHome(false);
      } else {
        // Keep the world point that was centred, centred.
        cameraRef.current = {
          ...cameraRef.current,
          x: cameraRef.current.x + (width - previous.width) / 2,
          y: cameraRef.current.y + (height - previous.height) / 2,
        };
      }
      // Repaint immediately rather than waiting for the next invalidation, or a resize
      // leaves a stretched stale image on screen.
      draw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    // The container, not the window: the fullscreen toggle resizes the stage without a
    // window resize event ever firing.
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw, goHome]);

  // A webfont resolving after first paint invalidates every measured label width.
  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (cancelled) return;
      clearTextCache();
      requestDraw();
    });
    return () => {
      cancelled = true;
    };
  }, [requestDraw]);

  // Sprites bake the theme's colours in, so a theme flip has to drop them.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      clearSpriteCaches();
      requestDraw();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, [requestDraw]);

  /**
   * A hidden tab gets no frames. Any camera flight in progress is snapped to its end
   * state rather than resumed, so coming back shows the destination, not a stale
   * midpoint of an animation nobody watched.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) cancelTween();
      else requestDraw();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [cancelTween, requestDraw]);

  useEffect(() => () => {
    if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
    if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
  }, []);

  // --- redraw triggers ----------------------------------------------------
  useEffect(() => {
    requestDraw();
  }, [requestDraw, index, focus, focusCluster, focusCompany, selection, hoveredId]);

  // A new layout is a new sky: reframe it rather than leaving the camera over a region
  // that may no longer hold anyone.
  useEffect(() => {
    if (framedKeyRef.current === layoutKey) return;
    const first = framedKeyRef.current === null;
    framedKeyRef.current = layoutKey;
    goHome(!first);
  }, [layoutKey, goHome]);

  // --- camera intents from the chrome ------------------------------------
  useEffect(() => {
    if (homeToken <= 0) return;
    goHome(homeToken > 1);
  }, [homeToken, goHome]);

  useEffect(() => {
    if (zoomToken <= 0 || searchHitIds.size === 0) return;
    const points: Vec2[] = [];
    for (const id of searchHitIds) {
      const star = indexRef.current.starsById.get(id);
      if (star) points.push({ x: star.x, y: star.y });
    }
    const rect = rectOf(points, 40);
    if (!rect) return;
    const single = searchHitIds.size === 1;
    flyTo(
      fitWorldRect(rect, paneRef.current, {
        padding: single ? 0.55 : 0.45,
        maxZoom: single ? 1.75 : 1.2,
      }),
      CAMERA_MS.snap
    );
  }, [zoomToken, searchHitIds, flyTo]);

  useEffect(() => {
    if (!focusCluster) return;
    const points: Vec2[] = [];
    for (const star of indexRef.current.stars) {
      if (star.data.clusterId === focusCluster) points.push({ x: star.x, y: star.y });
    }
    const rect = rectOf(points, 80);
    if (!rect) return;
    flyTo(fitWorldRect(rect, paneRef.current, { padding: 0.3, maxZoom: 1.2 }), CAMERA_MS.wide);
  }, [focusCluster, flyTo]);

  useEffect(() => {
    if (peekToken <= 0 || !peekPersonId) return;
    const star = indexRef.current.starsById.get(peekPersonId);
    if (!star) return;
    flyTo(
      fitWorldRect(rectOf([{ x: star.x, y: star.y }], 40)!, paneRef.current, {
        padding: 0.55,
        maxZoom: 1.8,
      }),
      CAMERA_MS.snap
    );
  }, [peekToken, peekPersonId, flyTo]);

  // --- taps ---------------------------------------------------------------
  const handleTap = useCallback(
    (screen: Vec2) => {
      const camera = cameraRef.current;
      const world = screenToWorld(screen, camera);
      const grid = indexRef.current.grid;
      const tolerance = TAP_TOLERANCE_PX / camera.k;

      /**
       * Stars first, and only then the haze. A nebula is hundreds of world units across
       * and sits under its own members, so testing it in the same pass would mean tapping
       * a person inside a cluster reframes the cluster instead of opening the person.
       */
      const star = hitTest(grid, world, tolerance, (t) => t.kind === "contact" || t.kind === "user");
      if (star) {
        if (star.kind === "user") {
          const sun = indexRef.current.sun;
          if (sun) onSelect(selectionForUser(sun.data, data.summary));
          return;
        }
        if (compact) {
          router.push(`/contacts/${star.id}`);
          return;
        }
        const entry = indexRef.current.starsById.get(star.id);
        if (entry) onSelect(selectionForContact(star.id, entry.data as GraphNodeData));
        return;
      }

      if (!compact) {
        const cluster = hitTest(
          grid,
          world,
          tolerance,
          (t) => t.kind === "clusterLabel" || t.kind === "nebula"
        );
        if (cluster) {
          const entry =
            indexRef.current.clusterLabels.find((l) => l.id === cluster.id) ??
            indexRef.current.nebulae.find((n) => n.id === cluster.id);
          const clusterId = clusterIdFromNodeId(cluster.id, entry?.clusterId);
          if (clusterId) onFocusCluster(clusterId);
          return;
        }
      }

      onSelect(null);
    },
    [compact, data.summary, onFocusCluster, onSelect, router]
  );

  const [, setSettledCamera] = useState(0);
  const gestureHandlers = useMemo(
    () => ({
      cameraRef,
      bounds: () => indexRef.current.bounds,
      pane: () => paneRef.current,
      onCameraChanged: requestDraw,
      onTap: handleTap,
      // React learns the camera only once a gesture is over, and only because the
      // accessible summary below reports what is in view.
      onSettled: () => setSettledCamera((n) => n + 1),
      reducedMotion: prefersReducedMotion,
      cancelTween,
    }),
    [requestDraw, handleTap, prefersReducedMotion, cancelTween]
  );
  useSkyGestures(containerRef, gestureHandlers);

  const clusterCount = data.clusters?.length ?? 0;
  const contactCount = index.stars.length;

  return (
    <div
      ref={containerRef}
      /**
       * `touch-action` is consulted when a gesture STARTS, so it has to be here rather
       * than set from a handler. Without it every pan scrolls the app shell's `main`
       * instead, which reads as the map simply refusing to move.
       */
      className="absolute inset-0 touch-none overscroll-none select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none]"
      role="application"
      aria-label="Constellation star chart"
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />

      {/*
        A canvas is opaque to a screen reader, so the chart states what it holds and then
        hands over to the list view, which is the same people in a form that can actually
        be read line by line. Deliberately not 3,000 offscreen buttons — that is the DOM
        cost this renderer exists to remove, wearing a hat.
      */}
      <p className="sr-only">
        A star chart of {contactCount} {contactCount === 1 ? "person" : "people"} around
        you
        {clusterCount > 0
          ? `, grouped into ${clusterCount} ${clusterCount === 1 ? "company or school" : "companies and schools"}`
          : ""}
        . This is a visual view —{" "}
        <Link href="/contacts">browse the same people as a list</Link>.
      </p>

      <div role="status" aria-live="polite" className="sr-only">
        {selection?.type === "contact"
          ? `Selected ${selection.data.label}${
              selection.data.company ? `, ${selection.data.company}` : ""
            }${selection.data.closenessTier ? `, ${selection.data.closenessTier} orbit` : ""}`
          : selection?.type === "user"
            ? "Selected you, at the centre of your constellation"
            : ""}
      </div>

      {/*
        The search hits, as real controls. Search is how anyone finds a specific person,
        so it has to work without sight — and the semantic search caps its own results,
        which is what keeps this list small enough to be a list.
      */}
      {searchHitIds.size > 0 && (
        <ul className="sr-only">
          {[...searchHitIds].map((id) => {
            const star = index.starsById.get(id);
            if (!star) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onSelect(selectionForContact(id, star.data as GraphNodeData))}
                >
                  {star.data.label}
                  {star.data.company ? `, ${star.data.company}` : ""}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
