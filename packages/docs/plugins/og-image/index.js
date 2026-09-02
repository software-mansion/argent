// @ts-check
/**
 * Generates one Open Graph image per page at build time and points the
 * `og:image` / `twitter:image` tags of every built HTML file at it.
 *
 * The card is `static/img/og-background.png` with a frosted glass panel, the
 * white Argent logo centred on the panel and the page title underneath.
 *
 * Background and panel are the same on every card, so they are rendered once
 * into a bitmap and reused; only the logo and the title are per page.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/** Standard Open Graph card size. */
const WIDTH = 1200;
const HEIGHT = 630;

/** Frosted glass panel, centred on the canvas. */
const PANEL = {
  width: 920,
  height: 400,
  radius: 32,
  /** `#C3D3E033`, drawn over the blurred background. */
  tint: "#C3D3E0",
  tintOpacity: 0x33 / 0xff,
  /** `backdrop-filter: blur(60px)`; an SVG blur takes half that as its standard deviation. */
  blurStdDeviation: 30,
};
const PANEL_X = (WIDTH - PANEL.width) / 2;
const PANEL_Y = (HEIGHT - PANEL.height) / 2;

/** Logo and title inside the panel. */
const LOGO_WIDTH = 280;
const LOGO_ASPECT = 36.75 / 194; // viewBox of static/img/logo.svg
const LOGO_GAP = 40;
const TITLE_FONT_SIZE = 56;
const TITLE_LINE_HEIGHT = 1.25;
const TITLE_COLOR = "#FFFFFF";
const CONTENT_PADDING = 64;

const ASSETS_DIR = path.join(__dirname, "..", "..", "scripts", "og-assets");
const STATIC_IMG_DIR = path.join(__dirname, "..", "..", "static", "img");

/** Card output directory, relative to the build output. */
const OUT_SUBDIR = path.join("img", "og");

/**
 * @param {string} baseUrl
 * @param {string} routePath
 * @returns {string}
 */
function fileNameForRoute(baseUrl, routePath) {
  const relative = routePath.startsWith(baseUrl) ? routePath.slice(baseUrl.length) : routePath;
  const slug = relative.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
  return `${slug === "" ? "index" : slug.toLowerCase()}.png`;
}

/**
 * Reads the page title out of a built HTML file: Docusaurus renders
 * `<title>Page | Argent</title>`, and `<title>Argent</title>` on the home page.
 *
 * `null` means a card with the logo alone: the home page, whose title is the
 * site title the logo already shows, and the search page, whose title the
 * search theme renders as `[object Object]`.
 *
 * @param {string} html
 * @param {string} siteTitle
 * @returns {string | null}
 */
function titleFromHtml(html, siteTitle) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) {
    return null;
  }
  const decoded = match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
  const withoutSuffix = decoded.replace(new RegExp(`\\s*\\|\\s*${siteTitle}\\s*$`), "").trim();
  if (withoutSuffix === "" || withoutSuffix === siteTitle || withoutSuffix === "[object Object]") {
    return null;
  }
  return withoutSuffix;
}

/**
 * Points the social image tags of a built page at `imageUrl` and declares the
 * card size.
 *
 * @param {string} html
 * @param {string} imageUrl
 * @returns {string}
 */
function rewriteImageTags(html, imageUrl) {
  const escaped = imageUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  /**
   * @param {string} source
   * @param {RegExp} tagPattern
   * @returns {string}
   */
  const setContent = (source, tagPattern) =>
    source.replace(tagPattern, (tag) => tag.replace(/content="[^"]*"/i, `content="${escaped}"`));

  let next = setContent(html, /<meta\b[^>]*\bproperty="og:image"[^>]*>/gi);
  next = setContent(next, /<meta\b[^>]*\bname="twitter:image"[^>]*>/gi);

  if (!/property="og:image:width"/i.test(next)) {
    next = next.replace(
      /<meta\b[^>]*\bproperty="og:image"[^>]*>/i,
      (tag) =>
        `${tag}<meta property="og:image:width" content="${WIDTH}"/>` +
        `<meta property="og:image:height" content="${HEIGHT}"/>`
    );
  }
  return next;
}

/**
 * The background and frosted glass panel, identical on every card.
 *
 * @param {(svg: string) => Buffer} renderSvg
 * @returns {Promise<string>} a `data:` URI holding the rendered PNG
 */
async function renderPlate(renderSvg) {
  const background = await fs.readFile(path.join(STATIC_IMG_DIR, "og-background.png"));
  const backgroundUri = `data:image/png;base64,${background.toString("base64")}`;
  const rect = `x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL.width}" height="${PANEL.height}" rx="${PANEL.radius}" ry="${PANEL.radius}"`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <clipPath id="panel"><rect ${rect}/></clipPath>
    <filter id="frost" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="${PANEL.blurStdDeviation}"/>
    </filter>
  </defs>
  <image x="0" y="0" width="${WIDTH}" height="${HEIGHT}" xlink:href="${backgroundUri}"/>
  <g clip-path="url(#panel)">
    <image x="0" y="0" width="${WIDTH}" height="${HEIGHT}" filter="url(#frost)" xlink:href="${backgroundUri}"/>
    <rect ${rect} fill="${PANEL.tint}" fill-opacity="${PANEL.tintOpacity}"/>
  </g>
</svg>`;

  return `data:image/png;base64,${renderSvg(svg).toString("base64")}`;
}

/**
 * The Argent logo recoloured white, as a `data:` URI satori can draw.
 *
 * @returns {Promise<string>}
 */
async function loadWhiteLogo() {
  const source = await fs.readFile(path.join(STATIC_IMG_DIR, "logo.svg"), "utf8");
  const white = source.replace(/#0D0F26/gi, TITLE_COLOR);
  return `data:image/svg+xml;base64,${Buffer.from(white).toString("base64")}`;
}

/** @type {import('@docusaurus/types').PluginModule} */
module.exports = function ogImagePlugin() {
  return {
    name: "argent/og-image",

    async postBuild({ outDir, routesPaths, siteConfig }) {
      const { default: satori } = await import("satori");
      const { Resvg } = require("@resvg/resvg-js");

      /** @param {string} svg */
      const renderSvg = (svg) =>
        new Resvg(svg, {
          fitTo: { mode: "width", value: WIDTH },
          // Satori embeds every glyph as a path, so no font lookup is needed.
          font: { loadSystemFonts: false },
        })
          .render()
          .asPng();

      const font = await fs.readFile(path.join(ASSETS_DIR, "DMSans-Medium.ttf"));
      const [plateUri, logoUri] = await Promise.all([renderPlate(renderSvg), loadWhiteLogo()]);

      const outputDir = path.join(outDir, OUT_SUBDIR);
      await fs.mkdir(outputDir, { recursive: true });

      const baseUrl = siteConfig.baseUrl;
      const imageBase = `${siteConfig.url.replace(/\/+$/, "")}${baseUrl}${OUT_SUBDIR.split(path.sep).join("/")}/`;
      let generated = 0;

      for (const routePath of routesPaths) {
        // Most routes are directories holding an index.html; `/404.html` is
        // a file.
        const relative = path.relative(baseUrl, `/${routePath.replace(/^\/+/, "")}`);
        const htmlPath = routePath.endsWith(".html")
          ? path.join(outDir, relative)
          : path.join(outDir, relative, "index.html");
        let html;
        try {
          html = await fs.readFile(htmlPath, "utf8");
        } catch {
          continue;
        }

        const title = titleFromHtml(html, siteConfig.title);

        // Satori takes the React element shape, which is a plain object, so
        // the card is described as an object literal rather than JSX.
        const element = /** @type {import("react").ReactNode} */ (
          /** @type {unknown} */ ({
            type: "div",
            props: {
              style: {
                width: PANEL.width,
                height: PANEL.height,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: CONTENT_PADDING,
              },
              children: [
                {
                  type: "img",
                  props: {
                    src: logoUri,
                    width: LOGO_WIDTH,
                    height: Math.round(LOGO_WIDTH * LOGO_ASPECT),
                  },
                },
                title === null
                  ? null
                  : {
                      type: "div",
                      props: {
                        style: {
                          marginTop: LOGO_GAP,
                          display: "flex",
                          fontFamily: "DM Sans",
                          fontWeight: 500,
                          fontSize: TITLE_FONT_SIZE,
                          lineHeight: TITLE_LINE_HEIGHT,
                          color: TITLE_COLOR,
                          textAlign: "center",
                        },
                        children: title,
                      },
                    },
              ],
            },
          })
        );

        const layer = await satori(element, {
          width: PANEL.width,
          height: PANEL.height,
          fonts: [{ name: "DM Sans", data: font, weight: 500, style: "normal" }],
        });

        const card = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <image x="0" y="0" width="${WIDTH}" height="${HEIGHT}" xlink:href="${plateUri}"/>
  <g transform="translate(${PANEL_X} ${PANEL_Y})">${layer.replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g>
</svg>`;

        const fileName = fileNameForRoute(baseUrl, routePath);
        await fs.writeFile(path.join(outputDir, fileName), renderSvg(card));
        await fs.writeFile(htmlPath, rewriteImageTags(html, `${imageBase}${fileName}`));
        generated += 1;
      }

      console.log(`[og-image] generated ${generated} Open Graph images in ${OUT_SUBDIR}`);
    },
  };
};
