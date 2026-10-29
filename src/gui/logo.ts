import { readFile } from "node:fs/promises";

/** Embed the trusted brand asset with isolated identifiers and nonce-scoped CSS. */
export async function embedLogo(html: string, nonce: string): Promise<string> {
  const source = (await readFile(new URL("../../system-assets/gui/flywheel-logo.svg", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  let instance = 0;
  return html.replace(/<img class="flywheel-mark"[^>]*>/g, () => {
    const prefix = `fw-logo-${instance++}-`;
    let svg = source;
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of ids) {
      svg = svg.replaceAll(`id="${id}"`, `id="${prefix}${id}"`)
        .replaceAll(`url(#${id})`, `url(#${prefix}${id})`)
        .replaceAll(`href="#${id}"`, `href="#${prefix}${id}"`);
    }
    svg = svg.replace(/aria-labelledby="[^"]*"/, 'aria-hidden="true"');
    let delays = "";
    let band = 0;
    svg = svg.replace(/style="--delay:([^\"]+)"/g, (_, delay: string) => {
      const cls = `delay-${band++}`;
      delays += `.${cls}{--delay:${delay}}\n`;
      return `class="${cls}"`;
    });
    svg = svg.replace(/<style>([\s\S]*?)<\/style>/, (_, css: string) =>
      `<style nonce="${nonce}">${(css + delays).replace(/\.([a-z][\w-]*)/g, `.${prefix}$1`)}</style>`);
    svg = svg.replace(/class="([^"]+)"/g, (_, classes: string) =>
      `class="${classes.split(/\s+/).map(cls => prefix + cls).join(" ")}"`);
    return svg.replace("<svg ", '<svg class="flywheel-mark" ');
  });
}
