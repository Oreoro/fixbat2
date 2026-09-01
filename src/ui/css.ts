import kumoCss from "./kumo.css";

/**
 * The stylesheet is served immutable, so its URL has to change when the CSS
 * does — otherwise returning visitors keep the previous version after a deploy.
 */
const version = (() => {
  let h = 5381;
  for (let i = 0; i < kumoCss.length; i++) h = ((h * 33) ^ kumoCss.charCodeAt(i)) >>> 0;
  return h.toString(36);
})();

import clientJs from "./client-bundle.txt";

export const CSS = kumoCss;
export const JS = clientJs;
export const CSS_PATH = "/kumo.css";
export const CSS_HREF = `${CSS_PATH}?v=${version}`;

const jsVersion = (() => {
  let h = 5381;
  for (let i = 0; i < clientJs.length; i++) h = ((h * 33) ^ clientJs.charCodeAt(i)) >>> 0;
  return h.toString(36);
})();
export const JS_PATH = "/client.js";
export const JS_HREF = `${JS_PATH}?v=${jsVersion}`;
