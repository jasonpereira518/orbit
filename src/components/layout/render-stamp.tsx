import { FreshOnArrival } from "@/components/layout/fresh-on-arrival";

/** The server's clock when this page rendered. A function, so the render itself stays pure. */
function serverNow() {
  return Date.now();
}

/**
 * Marks when the page around it was rendered, so a copy served later from a prefetch or the
 * router cache can tell it is old and refresh itself (`FreshOnArrival`). Every app page
 * renders one; it draws nothing.
 *
 * It has to be in the PAGE, not a layout or template: on a navigation Next re-renders only the
 * segment that changed, so a stamp in a shared layout would keep its first value forever.
 */
export function RenderStamp() {
  return <FreshOnArrival renderedAt={serverNow()} />;
}
