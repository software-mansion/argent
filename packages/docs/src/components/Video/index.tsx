import React from "react";
import clsx from "clsx";
import useBaseUrl from "@docusaurus/useBaseUrl";

import styles from "./styles.module.css";

type Props = {
  /* Site-relative path to the encoded MP4, e.g. "/video/tap-flow.mp4". */
  src: string;
  /*
   * Poster frame. Defaults to the sibling .jpg that scripts/encode-video.sh
   * writes next to every clip, so callers only pass this for a hand-picked
   * frame.
   */
  poster?: string;
  /* Simulator captures are tall; this caps their height instead of their width. */
  portrait?: boolean;
  caption?: React.ReactNode;
  /* Intrinsic pixel size, used to reserve space so the page does not reflow. */
  width?: number;
  height?: number;
  className?: string;
};

/*
 * A page can carry a dozen clips, so nothing is fetched until the player is
 * about to scroll into view: `src` stays off the element and `preload` is
 * "none" until then. Once loaded, playback follows visibility so off-screen
 * loops stop burning CPU.
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
       * This cannot move into the initial state: the server has no
       * IntersectionObserver either, so a lazy initializer would render "loaded"
       * on the server and "not loaded" in a browser that supports the observer,
       * which breaks hydration. It runs once, in the rare browser without the
       * API.
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

/*
 * Readers who ask for reduced motion get a paused player with controls rather
 * than a silent loop running on its own.
 */
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
   * The class fallback ratio only reserves space. Callers that pass width and
   * height get an exact box up front; the rest are corrected once the file
   * reports its own dimensions.
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
      /* Autoplay can still be refused (low power mode); a rejection is fine. */
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
