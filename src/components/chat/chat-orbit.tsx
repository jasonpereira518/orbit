"use client";

import { useState, type CSSProperties } from "react";
import { IntentLink } from "@/components/ui/intent-link";
import { AnimatePresence, motion } from "motion/react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { SPRING_SOFT } from "@/lib/motion";
import { ORBIT_FACE, ORBIT_RINGS, ORBIT_SIZE } from "@/lib/chat-orbit-geometry";
import type { OrbitPerson } from "@/lib/chat-orbit-people";

/**
 * The scene behind a working answer: a planet, two rings, and the people the search is looking
 * at circling it. Each face is the person's profile photo, and clicking it opens their profile.
 *
 * The motion is CSS (`.chat-orbit-*` in globals.css), not JS, for two reasons that matter here.
 * It pauses on hover and focus, which a photo you mean to click needs — a moving target is a
 * bad one. And reduced motion is decided by a media query rather than a hook that reports the
 * wrong value on its first render, so nobody briefly sees a spin they asked not to.
 *
 * The rings ignore the pointer and only the faces take it. Rings are boxes the size of their
 * orbit, and a later ring's box lies over every ring inside it — so with the rings live, the
 * outer one swallowed every click meant for a face on the inner one. (`pointer-events` is
 * inherited, which is why each face has to opt back in.)
 *
 * Nesting is deliberate. A ring spins; a person is placed at a fixed angle on it; and two
 * wrappers keep them upright — one cancels the placement angle, the other (`chat-orbit-rider`)
 * cancels the ring's spin. Without both, faces would tumble as they travel.
 */

const SIZE = ORBIT_SIZE;
const CENTER = SIZE / 2;
const FACE = ORBIT_FACE;
const RINGS = ORBIT_RINGS;

export function ChatOrbit({
  people,
  reduceMotion,
}: {
  people: readonly OrbitPerson[];
  reduceMotion: boolean;
}) {
  // Which face the pointer or keyboard is on, so its name can be read out under the scene —
  // a 28px photo is a poor way to say who someone is.
  const [focused, setFocused] = useState<string | null>(null);

  // Each ring takes the next `capacity` people after those the rings inside it hold. Derived
  // from the capacities rather than a running counter, so render stays free of mutation.
  const rings = RINGS.map((ring, index) => {
    const start = RINGS.slice(0, index).reduce((n, r) => n + r.capacity, 0);
    return { ring, riders: people.slice(start, start + ring.capacity) };
  });

  const caption =
    focused ?? (people.length === 0 ? "Looking…" : `Looking at ${people.length} ${people.length === 1 ? "person" : "people"}`);

  return (
    <div className="flex shrink-0 flex-col items-center">
      <div
        className="chat-orbit relative"
        style={{ width: SIZE, height: SIZE }}
        role="group"
        aria-label="People being looked at"
      >
        {/* The planet: brand teal with a lit edge and a tilted gold ring. Decoration only. */}
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <div className="size-8 rounded-full bg-primary shadow-[inset_-4px_-4px_8px_rgb(0_0_0/0.3),inset_3px_3px_6px_rgb(255_255_255/0.28)]" />
          <div className="absolute left-1/2 top-1/2 h-3.5 w-12 -translate-x-1/2 -translate-y-1/2 -rotate-[18deg] rounded-[50%] border border-amber-300/70" />
        </div>

        {rings.map(({ ring, riders }, ringIndex) => (
          <div
            key={ring.radius}
            className="chat-orbit-ring pointer-events-none absolute rounded-full border border-primary/20"
            style={
              {
                width: ring.radius * 2,
                height: ring.radius * 2,
                left: CENTER - ring.radius,
                top: CENTER - ring.radius,
                "--orbit-dur": ring.duration,
                "--orbit-dir": ring.direction,
                "--orbit-counter": ring.direction === "normal" ? "reverse" : "normal",
              } as CSSProperties
            }
          >
            {/* Until anyone is found, a lone satellite keeps the scene alive — the same dot
                the tiny header mark uses, so "searching" reads the same at any size. */}
            {ringIndex === 0 && people.length === 0 && (
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
              />
            )}

            <AnimatePresence initial={false}>
              {riders.map((person, i) => {
                const angle = ring.offset + (360 / ring.capacity) * i;
                return (
                  <div
                    key={person.id}
                    className="absolute left-1/2 top-1/2 size-0"
                    style={{ transform: `rotate(${angle}deg) translateY(-${ring.radius}px)` }}
                  >
                    <div style={{ transform: `rotate(${-angle}deg)` }}>
                      <div className="chat-orbit-rider">
                        <motion.div
                          className="absolute"
                          style={{ left: -FACE / 2, top: -FACE / 2, width: FACE, height: FACE }}
                          initial={reduceMotion ? false : { scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={reduceMotion ? { opacity: 0 } : { scale: 0, opacity: 0 }}
                          transition={SPRING_SOFT}
                        >
                          {/*
                            A new tab, deliberately. This scene exists while an answer is still
                            being written, and following a link in place would leave the chat
                            mid-answer — the person clicked to peek at someone, not to lose
                            the thread they were waiting on.
                          */}
                          <IntentLink
                            href={`/contacts/${person.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${person.name}’s profile`}
                            onMouseEnter={() => setFocused(person.name)}
                            onMouseLeave={() => setFocused(null)}
                            onFocus={() => setFocused(person.name)}
                            onBlur={() => setFocused(null)}
                            className="pointer-events-auto block size-full rounded-full ring-2 ring-background transition-transform hover:z-10 hover:scale-125 focus-visible:z-10 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-primary"
                          >
                            <ContactAvatar
                              contactId={person.id}
                              fullName={person.name}
                              profileImageUrl={person.photoUrl}
                              size="sm"
                              className="size-full"
                            />
                          </IntentLink>
                        </motion.div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </AnimatePresence>
          </div>
        ))}
      </div>

      <p className="mt-1 h-4 max-w-[9.5rem] truncate text-center text-[11px] text-muted-foreground">
        {caption}
      </p>
    </div>
  );
}
