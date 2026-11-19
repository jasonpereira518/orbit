"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Play } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const TRAILER = "/landing/trailer/orbit-trailer-1080p.mp4";
const PREVIEW = "/landing/trailer/orbit-trailer-preview.mp4";
const STILL = "/landing/trailer/orbit-trailer-still.jpg";
const CAPTIONS = "/landing/trailer/orbit-trailer-en.vtt";

export function LandingTrailer({
  children,
  reducedMotion,
}: {
  children: ReactNode;
  reducedMotion: boolean;
}) {
  const logoRef = useRef<HTMLAnchorElement>(null);
  const trailerButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const fullVideo = useRef<HTMLVideoElement>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overlayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const playbackAttempt = useRef(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [mediaActive, setMediaActive] = useState(false);
  const [playbackIssue, setPlaybackIssue] = useState<"blocked" | "failed" | null>(null);

  useEffect(() => () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(overlayTimer.current);
  }, []);

  function revealOverlay() {
    setOverlayVisible(true);
    clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setOverlayVisible(false), 2000);
  }

  function hidePreview() {
    clearTimeout(hoverTimer.current);
    previewVideo.current?.pause();
    setPreviewOpen(false);
  }

  function enterPreview(event: PointerEvent) {
    if (
      playerOpen ||
      event.pointerType !== "mouse" ||
      !window.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches
    ) return;

    clearTimeout(hoverTimer.current);
    if (!previewOpen) {
      hoverTimer.current = setTimeout(() => {
        setPreviewOpen(true);
        void previewVideo.current?.play().catch(() => setPreviewPlaying(false));
      }, 160);
    }
  }

  function leavePreview(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    clearTimeout(hoverTimer.current);
    if (previewOpen) hoverTimer.current = setTimeout(hidePreview, 200);
  }

  function playTrailer(reload: boolean) {
    const video = fullVideo.current;
    if (!video) return;

    const attempt = ++playbackAttempt.current;
    setPlaybackIssue(null);
    video.muted = false;
    if (reload) {
      video.src = TRAILER;
    }
    // Keep play() in the activation handler for browsers that require a gesture.
    void video.play().catch((error: unknown) => {
      if (attempt !== playbackAttempt.current) return;
      setPlaybackIssue(error instanceof DOMException && error.name === "NotAllowedError"
        ? "blocked"
        : "failed");
    });
  }

  function openPlayer(trigger: HTMLElement | null) {
    returnFocus.current = trigger;
    hidePreview();
    setPlayerOpen(true);
    revealOverlay();
    setMediaActive(true);
    playTrailer(true);
  }

  function closePlayer() {
    clearTimeout(overlayTimer.current);
    ++playbackAttempt.current;
    fullVideo.current?.pause();
    setPlayerOpen(false);
  }

  function releaseMedia() {
    // Leave the paused frame in place until the closing transition ends.
    const video = fullVideo.current;
    if (video) {
      video.removeAttribute("src");
      video.load();
    }
    setMediaActive(false);
    setPlaybackIssue(null);
  }

  return (
    <Dialog
      open={playerOpen}
      onOpenChange={(open) => { if (!open) closePlayer(); }}
      onOpenChangeComplete={(open) => { if (!open) releaseMedia(); }}
    >
      <div className="flex shrink-0 items-center gap-2">
        <Link
          ref={logoRef}
          href="/"
          aria-label="Orbit, back to top"
          className="flex items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#e8f3f1] sm:gap-2.5"
          onPointerEnter={enterPreview}
          onPointerLeave={leavePreview}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            hidePreview();
            window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
          }}
        >
          {children}
        </Link>
        <button
          ref={trailerButtonRef}
          type="button"
          aria-label="Watch the Orbit trailer"
          aria-haspopup="dialog"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-[#e8f3f1] ring-1 ring-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:sr-only [@media(hover:hover)_and_(pointer:fine)]:focus-visible:not-sr-only [@media(hover:hover)_and_(pointer:fine)]:focus-visible:size-8"
          onClick={() => openPlayer(trailerButtonRef.current)}
        >
          <Play aria-hidden size={14} fill="currentColor" />
        </button>
      </div>

      <Popover.Root
        open={previewOpen}
        onOpenChange={(open) => { if (!open) hidePreview(); }}
        onOpenChangeComplete={(open) => { if (!open) setPreviewPlaying(false); }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={logoRef}
            side="bottom"
            align="start"
            sideOffset={12}
            collisionPadding={12}
            className="pointer-events-auto z-[60]"
          >
            <Popover.Popup
              aria-label="Orbit trailer preview"
              initialFocus={false}
              finalFocus={false}
              onPointerEnter={enterPreview}
              onPointerLeave={leavePreview}
              className="w-80 max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) overflow-hidden rounded-xl bg-[#0e1424] text-[#e8f3f1] shadow-xl ring-1 ring-white/15 outline-none motion-safe:transition-[opacity,scale] motion-safe:duration-200 motion-safe:ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:scale-95 motion-safe:data-[ending-style]:scale-95"
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label="Play the full Orbit trailer"
                aria-haspopup="dialog"
                className="block w-full cursor-pointer text-left"
                onClick={() => openPlayer(logoRef.current)}
              >
                <span
                  className="relative block aspect-video bg-black bg-cover bg-center"
                  style={{ backgroundImage: `url("${STILL}")` }}
                >
                  {!reducedMotion && (
                    <video
                      ref={previewVideo}
                      src={PREVIEW}
                      autoPlay
                      muted
                      loop
                      playsInline
                      aria-hidden="true"
                      onPlaying={() => setPreviewPlaying(true)}
                      onError={() => setPreviewPlaying(false)}
                      className={cn("absolute inset-0 h-full w-full", !previewPlaying && "opacity-0")}
                    />
                  )}
                  <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-linear-to-t from-black/65 to-transparent px-4 pt-6 pb-3 text-sm font-medium text-white">
                    <Play aria-hidden size={15} fill="currentColor" />
                    Watch Trailer
                  </span>
                </span>
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {/* Mount the empty player ahead of time so the opening click can call play directly. */}
      <DialogPortal keepMounted>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-[1.5px] motion-safe:transition-opacity motion-safe:duration-[250ms] motion-safe:ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <DialogPrimitive.Popup
          ref={playerRef}
          initialFocus={playerRef}
          onPointerMove={revealOverlay}
          onPointerDown={revealOverlay}
          finalFocus={() => returnFocus.current}
          className="fixed top-1/2 left-1/2 z-[71] max-h-[calc(100dvh-2rem)] w-[min(calc(100%-2rem),70rem,max(18rem,calc((100dvh-6rem)*16/9)))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl bg-[#0e1424] text-[#e8f3f1] shadow-2xl ring-1 ring-white/15 outline-none motion-safe:transition-[opacity,scale] motion-safe:duration-[250ms] motion-safe:ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:scale-[0.96] motion-safe:data-[ending-style]:scale-[0.96]"
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 bg-linear-to-b from-black/65 to-transparent px-4 pt-2 pb-6 text-white focus-within:opacity-100 motion-safe:transition-opacity motion-safe:duration-200",
              !overlayVisible && "opacity-0"
            )}
          >
            <DialogTitle className="font-medium">Orbit Trailer</DialogTitle>
            <DialogClose
              render={<Button variant="ghost" className={cn("text-white hover:bg-white/10 hover:text-white focus-visible:pointer-events-auto", overlayVisible && "pointer-events-auto")} />}
            >
              Close
            </DialogClose>
          </div>
          <video
            ref={fullVideo}
            aria-label="Orbit Trailer"
            className="block aspect-video w-full bg-black"
            poster={mediaActive ? STILL : undefined}
            preload="none"
            controls
            playsInline
            onPlaying={() => setPlaybackIssue(null)}
            onError={() => {
              if (playerOpen && fullVideo.current?.error) setPlaybackIssue("failed");
            }}
          >
            {mediaActive && <track kind="captions" src={CAPTIONS} srcLang="en" label="English" />}
          </video>
          {playbackIssue && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span role="status">
                {playbackIssue === "blocked" ? "Playback is ready." : "The trailer couldn’t load."}
              </span>
              <Button onClick={() => playTrailer(playbackIssue === "failed")}>
                {playbackIssue === "blocked" ? "Play with sound" : "Retry"}
              </Button>
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
