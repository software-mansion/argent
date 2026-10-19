import React from "react";

/*
 * Brand marks for the integration pages, drawn with the same props as a
 * lucide icon so `ICONS` can hold both. Every mark uses `currentColor`, so
 * it follows the sidebar icon colour in light and dark mode.
 */
export type BrandIconProps = {
  "className"?: string;
  "size"?: number;
  "strokeWidth"?: number;
  "aria-hidden"?: React.SVGAttributes<SVGSVGElement>["aria-hidden"];
};

export type BrandIcon = (props: BrandIconProps) => React.ReactElement;

type Mark = {
  viewBox: string;
  children: React.ReactNode;
  /* Stroke marks scale the stroke width with the mark; fill marks ignore it. */
  stroke?: boolean;
};

/*
 * Lucide draws its icons with `strokeWidth` on a 24 unit box. A stroke mark on
 * a wider box scales the stroke by the same ratio, so it keeps the weight of the
 * lucide icons next to it.
 */
function scaledStrokeWidth(viewBox: string, strokeWidth: number): number {
  const width = Number(viewBox.split(" ")[2]);
  return (strokeWidth * width) / 24;
}

function createBrandIcon({ viewBox, children, stroke = false }: Mark): BrandIcon {
  const Icon: BrandIcon = ({ className, size = 16, strokeWidth = 2, ...rest }) => (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={viewBox}
      fill={stroke ? "none" : "currentColor"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={stroke ? scaledStrokeWidth(viewBox, strokeWidth) : undefined}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}>
      {children}
    </svg>
  );
  return Icon;
}

/* The wireframe mark from `static/img/logo.svg`, without the wordmark. */
export const Argent = createBrandIcon({
  viewBox: "-3 -3 64 35.5",
  stroke: true,
  children: (
    <path d="M3.10976 18.9198L1 28.75H19.7769L17.6671 18.9198H3.10976ZM3.10976 18.9198L12.0935 14.75M38.8894 28.75H20.3846L22.4638 18.9198H36.8102M38.8894 28.75L36.8102 18.9198M38.8894 28.75L57 20.0897L54.9208 10.2594M36.8102 18.9198L54.9208 10.2594M47.8462 10.2994L54.9208 10.2594M47.8462 10.2994L29.8077 18.9198M47.8462 10.2994L45.767 0.75M13.31 9.16289L11.2308 18.9198L29.8077 18.9198M13.31 9.16289H27.6563M13.31 9.16289L31.4206 0.75H45.767M29.8077 18.9198L27.6563 9.16289M27.6563 9.16289L45.767 0.75" />
  ),
});

/* The Maestro tile from the maestro.dev favicon, with the mark cut out of it. */
export const Maestro = createBrandIcon({
  viewBox: "0 0 110.283 110.283",
  children: (
    <path
      fillRule="evenodd"
      d="M10 0h90.283a10 10 0 0 1 10 10v90.283a10 10 0 0 1-10 10H10a10 10 0 0 1-10-10V10A10 10 0 0 1 10 0Zm78.2372 20H20V90.2831H49.7006C46.6232 89.1682 43.9636 87.133 42.0832 84.4541C40.2026 81.7751 39.1924 78.5822 39.1896 75.3091C39.1881 73.2133 39.5996 71.1379 40.4007 69.2011C41.2016 67.2645 42.3764 65.5046 43.8578 64.0221C45.3392 62.5396 47.0983 61.3637 49.0344 60.5613C50.9706 59.7589 53.0457 59.346 55.1416 59.346C59.3723 59.346 63.4297 61.0266 66.4213 64.0182C69.4129 67.0097 71.0936 71.0672 71.0936 75.298C71.0907 78.571 70.0805 81.7639 68.2 84.4428C66.3195 87.1219 63.6599 89.157 60.5826 90.2719H90.2831V20H88.2372Z"
    />
  ),
});

/* Simple Icons: Appium (CC0). */
export const Appium = createBrandIcon({
  viewBox: "0 0 24 24",
  children: (
    <path d="M11.923 0C5.937 0 .976 4.384.07 10.115a11.943 11.943 0 0 1 7.645-2.754 11.982 11.982 0 0 1 9.43 4.58 11.942 11.942 0 0 0 1.015-8.769 12.066 12.066 0 0 0-.626-1.772l-.003-.008A11.968 11.968 0 0 0 11.923 0Zm7.721 2.754A12.002 12.002 0 0 1 9.398 16.521a12.082 12.082 0 0 0 9.02 5.617c.24-.119.766-.51 1.224-.89A11.971 11.971 0 0 0 23.995 12a11.98 11.98 0 0 0-4.35-9.247zM9.33 7.557a12.159 12.159 0 0 0-2.647.401A11.944 11.944 0 0 0 .01 12.595l-.005.006c.021.427.065.853.131 1.275C1.037 19.61 6 24 11.991 24c1.45 0 2.887-.26 4.243-.773a12 12 0 0 1-6.905-15.67z" />
  ),
});

/* Simple Icons: GitHub (CC0). */
export const GitHub = createBrandIcon({
  viewBox: "0 0 24 24",
  children: (
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  ),
});
