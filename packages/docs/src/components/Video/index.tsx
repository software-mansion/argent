import React from "react";
import clsx from "clsx";
import useBaseUrl from "@docusaurus/useBaseUrl";

import styles from "./styles.module.css";

type Props = {
  /* Site-relative path to the encoded MP4. */
  src: string;
  /* Defaults to the sibling .jpg that scripts/encode-video.sh writes. */
  poster?: string;
  /* Caps height instead of width, for tall simulator captures. */
  portrait?: boolean;
  caption?: React.ReactNode;
  /* Intrinsic pixel size; reserves space so the page does not reflow. */
  width?: number;
  height?: number;
  className?: string;
};

/*
 * A page can carry a dozen clips, so `src` stays off the element until the
 * player is about to scroll into view. After that, playback follows visibility
 * so off-screen loops stop burning CPU.
 */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean, boolean] {
  const ref = React.useRef<T>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [isVisible, setIsVisible] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    if (typeof IntersectionObserver === "undefined") {
      /*
       * Not the initial state: the server has no IntersectionObserver either, so
       * it would render loaded on the server and not loaded in a browser that
       * has the API, breaking hydration.
       */
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShouldLoad(true);
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
        }
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin: "200px 0px" }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, shouldLoad, isVisible];
}

/* Reduced motion trades the autoplaying loop for a paused player with controls. */
function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);

    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function defaultPoster(src: string): string {
  return src.replace(/\.(mp4|webm)$/i, ".jpg");
}

export default function Video({
  src,
  poster,
  portrait = false,
  caption,
  width,
  height,
  className,
}: Props): React.ReactElement {
  const [ref, shouldLoad, isVisible] = useNearViewport<HTMLVideoElement>();
  const prefersReducedMotion = usePrefersReducedMotion();
  /*
   * The ratio on the landscape/portrait class is only a placeholder; without
   * width and height props the real one arrives with the metadata.
   */
  const [measured, setMeasured] = React.useState<string | undefined>(undefined);
  const aspectRatio = width && height ? `${width} / ${height}` : measured;

  const resolvedSrc = useBaseUrl(src);
  const resolvedPoster = useBaseUrl(poster ?? defaultPoster(src));
  const autoPlay = !prefersReducedMotion;

  React.useEffect(() => {
    const element = ref.current;
    if (!element || !shouldLoad || !autoPlay) {
      return;
    }

    if (isVisible) {
      /* Autoplay can be refused (low power mode); the rejection is fine. */
      void element.play().catch(() => {});
    } else {
      element.pause();
    }
  }, [ref, shouldLoad, isVisible, autoPlay]);

  return (
    <figure className={clsx(styles.figure, className)}>
      <video
        ref={ref}
        src={shouldLoad ? resolvedSrc : undefined}
        poster={shouldLoad ? resolvedPoster : undefined}
        width={width}
        height={height}
        autoPlay={autoPlay}
        loop={autoPlay}
        controls={!autoPlay}
        muted
        playsInline
        preload="none"
        className={clsx(styles.video, portrait ? styles.portrait : styles.landscape)}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          if (element.videoWidth && element.videoHeight) {
            setMeasured(`${element.videoWidth} / ${element.videoHeight}`);
          }
        }}
        style={aspectRatio ? { aspectRatio } : undefined}
      />
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}
