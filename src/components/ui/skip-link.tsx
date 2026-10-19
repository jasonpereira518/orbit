"use client"

/**
 * "Skip to content": the first stop for a keyboard user on every page, so they do not tab
 * through the whole sidebar to reach it. Rendered once, in the root layout.
 *
 * It targets `#main-content` and falls back to the page's `<main>`, so a layout that has not
 * set the id still works. The target is made focusable on the way, because moving the
 * scroll position alone leaves the next Tab starting from the top of the document.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      onClick={(e) => {
        const target =
          document.getElementById("main-content") ?? document.querySelector("main")
        if (!target) return
        e.preventDefault()
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1")
        target.focus()
      }}
      className="sr-only rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg outline-none focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[10000] focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      Skip to content
    </a>
  )
}
