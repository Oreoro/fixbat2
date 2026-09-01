import { hydrateRoot } from "react-dom/client";
import { ISLANDS, type IslandName } from "./islands";

/**
 * Hydrates each marked island in place. Anything not marked stays static HTML,
 * so a page with no interactive parts costs nothing beyond this file.
 */
for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-island]"))) {
  const name = el.dataset.island as IslandName;
  const Component = ISLANDS[name] as ((p: unknown) => React.JSX.Element) | undefined;
  if (!Component) continue;
  try {
    const props = JSON.parse(el.dataset.props ?? "{}");
    hydrateRoot(el, <Component {...props} />);
  } catch (error) {
    console.error(`island ${name} failed to hydrate`, error);
  }
}
